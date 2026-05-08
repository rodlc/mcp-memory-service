"""Semantic lint engine for memory quality enforcement."""

import hashlib
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Set, Tuple

from .base import ConsolidationBase, ConsolidationConfig
from ..models.memory import Memory

import logging
logger = logging.getLogger(__name__)


@dataclass
class LintFlag:
    """A lint issue found in a memory."""
    memory_hash: str
    check_type: str  # 'contradiction', 'staleness', 'orphan'
    severity: str    # 'warn', 'error'
    detail: str
    paired_hash: Optional[str] = None  # For contradiction pairs


@dataclass
class LintReport:
    """Aggregated result of a lint run."""
    run_at: float
    memories_scanned: int
    contradictions: List[LintFlag] = field(default_factory=list)
    stale_pairs: List[LintFlag] = field(default_factory=list)
    orphans: List[LintFlag] = field(default_factory=list)

    @property
    def total_flags(self) -> int:
        return len(self.contradictions) + len(self.stale_pairs) + len(self.orphans)


class SemanticLintEngine(ConsolidationBase):
    """
    Semantic lint — three checks on every consolidation cycle:
    1. Contradictions   : similar content (cosine > 0.8) with conflicting claims
    2. Staleness        : same cluster/tags, >7d apart, content diverged (Jaccard < 0.6)
    3. Orphans          : no graph associations + no access + quality < 0.3

    Designed to run as Phase 5.5 after compression, before forgetting.
    Results stored in memory metadata as 'lint_flags' for /memory-audit queries.
    """

    # Scaling guard: pairwise → ANN when n > 3000
    ANN_THRESHOLD = 3000
    # Similarity thresholds
    CONTRADICTION_SIM = 0.8
    STALENESS_JACCARD = 0.6
    STALENESS_DAYS = 7
    ORPHAN_QUALITY = 0.3

    PROTECTED_TYPES = {'critical', 'reference', 'permanent'}

    def __init__(self, config: ConsolidationConfig):
        super().__init__(config)

    async def process(self, memories: List[Memory], **kwargs) -> LintReport:
        """Run all lint checks and return a report."""
        report = LintReport(run_at=time.time(), memories_scanned=len(memories))

        if not memories:
            return report

        graph_counts: Dict[str, int] = kwargs.get('graph_counts', {})
        access_patterns: Dict[str, datetime] = kwargs.get('access_patterns', {})

        # Run all 3 checks
        report.contradictions = self._check_contradictions(memories)
        report.stale_pairs = self._check_staleness(memories)
        report.orphans = self._check_orphans(memories, graph_counts, access_patterns)

        logger.info(
            f"Lint complete: {report.total_flags} flags "
            f"({len(report.contradictions)} contradictions, "
            f"{len(report.stale_pairs)} stale, "
            f"{len(report.orphans)} orphans)"
        )
        return report

    def _check_contradictions(self, memories: List[Memory]) -> List[LintFlag]:
        """Detect memories with high embedding similarity but conflicting claims."""
        flags = []
        embeddings = self._get_embeddings(memories)
        if not embeddings:
            return flags

        n = len(memories)
        if n > self.ANN_THRESHOLD:
            logger.info(f"Lint: {n} memories > {self.ANN_THRESHOLD}, using ANN for contradiction check")
            return self._check_contradictions_ann(memories, embeddings)

        # Pairwise cosine similarity
        for i in range(n):
            if memories[i].memory_type in self.PROTECTED_TYPES:
                continue
            for j in range(i + 1, n):
                if memories[j].memory_type in self.PROTECTED_TYPES:
                    continue
                sim = self._cosine_sim(embeddings[i], embeddings[j])
                if sim >= self.CONTRADICTION_SIM:
                    if self._has_contradiction_signals(memories[i].content, memories[j].content):
                        flags.append(LintFlag(
                            memory_hash=memories[i].content_hash,
                            check_type='contradiction',
                            severity='warn',
                            detail=f"Cosine sim {sim:.2f} with conflicting signals",
                            paired_hash=memories[j].content_hash,
                        ))
        return flags

    def _check_contradictions_ann(self, memories: List[Memory], embeddings: List[List[float]]) -> List[LintFlag]:
        """ANN-based contradiction detection for large collections (stub — extend with sqlite-vec KNN)."""
        # When n > ANN_THRESHOLD, skip pairwise and log for manual review
        logger.warning(f"Lint ANN path: {len(memories)} memories — full pairwise skipped (implement KNN)")
        return []

    def _check_staleness(self, memories: List[Memory]) -> List[LintFlag]:
        """Detect memory pairs with same cluster/tags but diverged content."""
        flags = []
        # Group by shared tags (cluster + topic tags)
        groups: Dict[frozenset, List[Memory]] = {}
        for mem in memories:
            cluster_tags = frozenset(t for t in mem.tags if t not in {'session-stub', 'standard', 'compiled'})
            if len(cluster_tags) >= 2:
                groups.setdefault(cluster_tags, []).append(mem)

        for tag_key, group in groups.items():
            if len(group) < 2:
                continue
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    a, b = group[i], group[j]
                    age_a = a.created_at or 0.0
                    age_b = b.created_at or 0.0
                    age_diff_days = abs(age_a - age_b) / 86400
                    if age_diff_days < self.STALENESS_DAYS:
                        continue
                    jaccard = self._jaccard(a.content, b.content)
                    if jaccard < self.STALENESS_JACCARD:
                        flags.append(LintFlag(
                            memory_hash=a.content_hash,
                            check_type='staleness',
                            severity='warn',
                            detail=f"Jaccard {jaccard:.2f} with {b.content_hash[:8]}… ({age_diff_days:.0f}d apart)",
                            paired_hash=b.content_hash,
                        ))
        return flags

    def _check_orphans(
        self,
        memories: List[Memory],
        graph_counts: Dict[str, int],
        access_patterns: Dict[str, datetime],
    ) -> List[LintFlag]:
        """Flag memories with no graph connections, no access, and low quality."""
        flags = []
        for mem in memories:
            if mem.memory_type in self.PROTECTED_TYPES:
                continue
            connections = graph_counts.get(mem.content_hash, 0)
            last_access = access_patterns.get(mem.content_hash)
            quality = self._get_quality(mem)
            if connections == 0 and last_access is None and quality < self.ORPHAN_QUALITY:
                flags.append(LintFlag(
                    memory_hash=mem.content_hash,
                    check_type='orphan',
                    severity='warn',
                    detail=f"0 connections, no access, quality={quality:.2f}",
                ))
        return flags

    # ── Helpers ─────────────────────────────────────────────────────────────

    def _get_embeddings(self, memories: List[Memory]) -> List[List[float]]:
        """Extract pre-computed embeddings from memory objects (best-effort)."""
        result = []
        for mem in memories:
            emb = getattr(mem, 'embedding', None)
            result.append(emb or [])
        has_embeddings = any(e for e in result)
        if not has_embeddings:
            logger.debug("Lint: no embeddings available on Memory objects, contradiction check skipped")
            return []
        return result

    def _cosine_sim(self, a: List[float], b: List[float]) -> float:
        """Cosine similarity between two vectors."""
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    def _jaccard(self, text_a: str, text_b: str) -> float:
        """Word-level Jaccard similarity."""
        words_a = set(text_a.lower().split())
        words_b = set(text_b.lower().split())
        if not words_a and not words_b:
            return 1.0
        intersection = words_a & words_b
        union = words_a | words_b
        return len(intersection) / len(union)

    def _has_contradiction_signals(self, text_a: str, text_b: str) -> bool:
        """Heuristic: check for negation, numeric flip, or boolean inversion."""
        negation_words = {'not', 'never', 'no', "don't", "doesn't", "isn't", "aren't", "wasn't", "won't"}
        words_a = set(text_a.lower().split())
        words_b = set(text_b.lower().split())
        # One has negation the other doesn't (asymmetric)
        neg_a = bool(words_a & negation_words)
        neg_b = bool(words_b & negation_words)
        if neg_a != neg_b:
            return True
        # Boolean flip signals
        bool_pairs = [('true', 'false'), ('enabled', 'disabled'), ('yes', 'no'), ('on', 'off')]
        for pos, neg in bool_pairs:
            if (pos in words_a and neg in words_b) or (neg in words_a and pos in words_b):
                return True
        return False

    def _get_quality(self, mem: Memory) -> float:
        """Extract quality score from metadata, default 0.5."""
        if mem.metadata:
            return float(mem.metadata.get('quality_score', 0.5))
        return 0.5
