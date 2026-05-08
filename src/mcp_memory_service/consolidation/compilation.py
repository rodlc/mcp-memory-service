"""
Karpathy-inspired compilation layer for MCP Memory.

Compile clusters of stubs into synthesized "wiki pages" that replace
the originals — one-time synthesis, maintain-on-change, prefer compiled
over raw stubs in /load.

LLM backend: Ollama HTTP direct (localhost:11434) — runs in the scheduler,
outside of Claude session context. Graceful skip if Ollama unavailable.
"""

import asyncio
import hashlib
import json
import logging
import os
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple

from .base import ConsolidationBase, ConsolidationConfig
from ..models.memory import Memory

logger = logging.getLogger(__name__)

# Default Ollama endpoint (override with COMPILATION_LLM_ENDPOINT env var)
DEFAULT_LLM_ENDPOINT = "http://localhost:11434/api/generate"
DEFAULT_LLM_MODEL = "llama3"


@dataclass
class CompilResult:
    """Result of a compilation run on a memory group."""
    group_key: str              # Tag-based group identifier
    compiled_memory: Memory
    source_hashes: List[str]
    staleness_hash: str         # SHA-256 of sorted source content_hashes
    skipped: bool = False
    skip_reason: str = ""


class CompilationEngine(ConsolidationBase):
    """
    Compilation layer: synthesize groups of stubs into single wiki-style pages.

    Replaces originals via soft-delete (same pattern as compression fix).
    Staleness tracking: recompiles only when source set changes (hash diverges).

    Design note: runs in scheduler (Python process), NOT in Claude session.
    LLM via Ollama HTTP direct — no MCP dependency.
    """

    def __init__(self, config: ConsolidationConfig, llm_endpoint: Optional[str] = None):
        super().__init__(config)
        self.llm_endpoint = llm_endpoint or os.environ.get(
            'COMPILATION_LLM_ENDPOINT', DEFAULT_LLM_ENDPOINT
        )
        self.llm_model = os.environ.get('COMPILATION_LLM_MODEL', DEFAULT_LLM_MODEL)
        self._ollama_available: Optional[bool] = None  # Lazy-check

    async def process(self, memories: List[Memory], **kwargs) -> List[CompilResult]:
        """
        Group memories by shared tags and compile each group.

        Only compiles groups of ≥3 session-stubs with shared non-trivial tags.
        Skips groups where staleness_hash matches the existing compiled memory.
        """
        if not memories:
            return []

        if not await self._check_ollama():
            logger.info("Compilation: Ollama unavailable — skipping cycle, retry next run")
            return []

        # Group session-stubs by shared topic tags
        groups = self._group_by_topic(memories)
        results = []

        for group_key, group_members in groups.items():
            if len(group_members) < 3:
                continue

            staleness_hash = self._compute_staleness_hash(group_members)
            existing = self._find_existing_compiled(memories, group_key)

            # Skip if already compiled and sources unchanged
            if existing and existing.metadata.get('staleness_hash') == staleness_hash:
                results.append(CompilResult(
                    group_key=group_key,
                    compiled_memory=existing,
                    source_hashes=[m.content_hash for m in group_members],
                    staleness_hash=staleness_hash,
                    skipped=True,
                    skip_reason="staleness_hash_match",
                ))
                continue

            compiled = await self._compile_group(group_key, group_members, staleness_hash)
            if compiled:
                results.append(compiled)

        return results

    async def apply(self, storage, results: List[CompilResult]) -> None:
        """Store compiled memories and soft-delete their sources."""
        for result in results:
            if result.skipped:
                continue
            success, _ = await storage.store(result.compiled_memory)
            if not success:
                logger.warning(f"Compilation: failed to store compiled memory for group {result.group_key}")
                continue
            for source_hash in result.source_hashes:
                try:
                    await storage.delete_memory(source_hash)
                except Exception as e:
                    logger.warning(f"Compilation: failed to soft-delete source {source_hash}: {e}")

    async def _compile_group(
        self,
        group_key: str,
        members: List[Memory],
        staleness_hash: str,
    ) -> Optional[CompilResult]:
        """Synthesize a group into a single compiled memory via Ollama."""
        combined = "\n\n---\n\n".join(
            f"[{i+1}] {m.content}" for i, m in enumerate(members)
        )
        prompt = (
            f"You are a memory compiler. Synthesize the following {len(members)} notes "
            f"about '{group_key}' into a single comprehensive wiki page. "
            f"Preserve all specific facts, dates, numbers, and decisions. "
            f"Remove redundancy. Output only the synthesized text.\n\n"
            f"{combined}"
        )

        synthesized = await self._call_ollama(prompt)
        if not synthesized:
            return None

        # Build compiled Memory
        all_tags = list({'compiled', f'domain:{group_key}', 'synthesis'} | {
            t for m in members for t in m.tags
            if t not in {'session-stub', 'standard'}
        })

        content_hash = hashlib.sha256(synthesized.encode()).hexdigest()[:32]
        compiled_mem = Memory(
            content=synthesized,
            content_hash=content_hash,
            tags=all_tags[:10],
            memory_type='synthesis',
            metadata={
                'source_memory_hashes': [m.content_hash for m in members],
                'staleness_hash': staleness_hash,
                'compiled_at': time.time(),
                'group_key': group_key,
                'source_count': len(members),
            },
            created_at=time.time(),
            created_at_iso=datetime.now().isoformat() + 'Z',
        )

        return CompilResult(
            group_key=group_key,
            compiled_memory=compiled_mem,
            source_hashes=[m.content_hash for m in members],
            staleness_hash=staleness_hash,
        )

    async def _check_ollama(self) -> bool:
        """Lazy-check Ollama availability (cached per instance)."""
        if self._ollama_available is not None:
            return self._ollama_available
        try:
            req = urllib.request.Request(
                self.llm_endpoint.replace('/api/generate', '/api/tags'),
                method='GET',
            )
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None, lambda: urllib.request.urlopen(req, timeout=3).close()
            )
            self._ollama_available = True
        except Exception:
            self._ollama_available = False
        return self._ollama_available

    async def _call_ollama(self, prompt: str) -> Optional[str]:
        """Call Ollama generate endpoint synchronously (scheduler context)."""
        payload = json.dumps({
            'model': self.llm_model,
            'prompt': prompt,
            'stream': False,
        }).encode()
        try:
            req = urllib.request.Request(
                self.llm_endpoint,
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )

            def _do_request():
                with urllib.request.urlopen(req, timeout=120) as resp:
                    return json.loads(resp.read())

            loop = asyncio.get_event_loop()
            data = await loop.run_in_executor(None, _do_request)
            return data.get('response', '').strip() or None
        except Exception as e:
            logger.warning(f"Compilation: Ollama call failed: {e}")
            return None

    def _group_by_topic(self, memories: List[Memory]) -> Dict[str, List[Memory]]:
        """Group session-stubs by their primary non-trivial tag."""
        groups: Dict[str, List[Memory]] = {}
        trivial = {'session-stub', 'standard', 'compiled', 'synthesis', 'cluster', 'compressed'}
        for mem in memories:
            if mem.memory_type not in (None, 'standard', 'session-stub'):
                continue
            topic_tags = [t for t in mem.tags if t not in trivial]
            if not topic_tags:
                continue
            # Use first non-trivial tag as group key
            key = topic_tags[0]
            groups.setdefault(key, []).append(mem)
        return groups

    def _find_existing_compiled(
        self, memories: List[Memory], group_key: str
    ) -> Optional[Memory]:
        """Find an existing compiled memory for a group."""
        for mem in memories:
            if mem.memory_type == 'synthesis' and mem.metadata.get('group_key') == group_key:
                return mem
        return None

    def _compute_staleness_hash(self, members: List[Memory]) -> str:
        """SHA-256 of sorted source content_hashes."""
        sorted_hashes = sorted(m.content_hash for m in members)
        return hashlib.sha256(''.join(sorted_hashes).encode()).hexdigest()
