#!/usr/bin/env python3
"""Batch-score all implicit-only memories with DeBERTa ONNX.

File lock: /tmp/mcp-memory-batch-score.lock — prevents concurrency with consolidation.
Skips memories already scored onnx_local. Reports count at end.
"""
import asyncio
import fcntl
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from mcp_memory_service.config import SQLITE_VEC_PATH, STORAGE_BACKEND
from mcp_memory_service.storage.factory import create_storage_instance
from mcp_memory_service.quality.scorer import QualityScorer
from mcp_memory_service.quality.config import QualityConfig, SUPPORTED_MODELS

logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

LOCK_FILE = "/tmp/mcp-memory-batch-score.lock"


async def batch_score():
    if STORAGE_BACKEND not in ('hybrid', 'sqlite_vec'):
        print(f"⚠️  Backend '{STORAGE_BACKEND}' not supported")
        return

    storage = await create_storage_instance(SQLITE_VEC_PATH, server_type="script")

    if STORAGE_BACKEND == 'hybrid' and hasattr(storage, 'pause_sync'):
        await storage.pause_sync()

    try:
        all_memories = await storage.get_all_memories()
        needs_scoring = [
            m for m in all_memories
            if m.memory_type not in ('association', 'compressed_cluster')
            and 'source_memory_hashes' not in (m.metadata or {})
            and (m.metadata or {}).get('quality_provider', 'implicit') != 'onnx_local'
        ]

        total = len(needs_scoring)
        print(f"Memories to score: {total}")
        if total == 0:
            print("All memories already have ONNX scores.")
            return

        scorer = QualityScorer()
        config = QualityConfig.from_env()
        model_cfg = SUPPORTED_MODELS.get(config.local_model, {})
        is_classifier = model_cfg.get('type', 'cross-encoder') == 'classifier'

        success = 0
        for i, memory in enumerate(needs_scoring, 1):
            try:
                query = "" if is_classifier else ' '.join((memory.tags or [])[:5])
                score = await scorer.calculate_quality_score(memory, query)
                if score is not None:
                    memory.metadata = memory.metadata or {}
                    memory.metadata['quality_score'] = score
                    memory.metadata['quality_provider'] = 'onnx_local'
                    await storage.update_memory(memory)
                    success += 1
            except Exception as e:
                logger.warning(f"Failed to score {memory.content_hash[:16]}: {e}")
            if i % 100 == 0:
                print(f"  [{i:5d}/{total}] done")

        print(f"✓ Scored {success}/{total} memories")
    finally:
        if STORAGE_BACKEND == 'hybrid' and hasattr(storage, 'resume_sync'):
            await storage.resume_sync()


def main():
    with open(LOCK_FILE, 'w') as lock_fh:
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another batch score is already running (lock held). Exiting.")
            sys.exit(0)
        asyncio.run(batch_score())


if __name__ == "__main__":
    main()
