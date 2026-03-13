"""
Tests for hash-based memory retrieval.

Covers:
- sqlite_vec.get_by_hash(): full hash, partial prefix, not found, ambiguous prefix
- memory_service.get_memory_by_hash(): found, partial, not found
- handle_get_memory_by_hash MCP handler: integration
"""
import os
import shutil
import tempfile
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio

try:
    import sqlite_vec
    SQLITE_VEC_AVAILABLE = True
except ImportError:
    SQLITE_VEC_AVAILABLE = False

from src.mcp_memory_service.models.memory import Memory
from src.mcp_memory_service.utils.hashing import generate_content_hash

if SQLITE_VEC_AVAILABLE:
    from src.mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage
    from src.mcp_memory_service.services.memory_service import MemoryService
    from src.mcp_memory_service.server.handlers.memory import handle_get_memory_by_hash

pytestmark = pytest.mark.skipif(
    not SQLITE_VEC_AVAILABLE, reason="sqlite-vec not available"
)


@pytest_asyncio.fixture
async def storage():
    temp_dir = tempfile.mkdtemp()
    db_path = os.path.join(temp_dir, "test_hash.db")
    s = SqliteVecMemoryStorage(db_path)
    await s.initialize()
    yield s
    if s.conn:
        s.conn.close()
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest_asyncio.fixture
async def stored_memory(storage):
    content = "Hash retrieval test memory — unique content for hash lookup"
    memory = Memory(
        content=content,
        content_hash=generate_content_hash(content),
        tags=["__test__", "hash-retrieval"],
        memory_type="note",
        metadata={},
    )
    await storage.store(memory)
    return memory


# ---------------------------------------------------------------------------
# Layer 1: sqlite_vec.get_by_hash
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_by_hash_full(storage, stored_memory):
    """Full 64-char hash returns the correct memory."""
    result = await storage.get_by_hash(stored_memory.content_hash)
    assert result is not None
    assert result.content_hash == stored_memory.content_hash
    assert result.content == stored_memory.content


@pytest.mark.asyncio
async def test_get_by_hash_partial(storage, stored_memory):
    """Unambiguous 16-char prefix returns the correct memory."""
    prefix = stored_memory.content_hash[:16]
    result = await storage.get_by_hash(prefix)
    assert result is not None
    assert result.content_hash == stored_memory.content_hash


@pytest.mark.asyncio
async def test_get_by_hash_not_found(storage):
    """Non-existent hash returns None."""
    result = await storage.get_by_hash("a" * 64)
    assert result is None


@pytest.mark.asyncio
async def test_get_by_hash_ambiguous_prefix(storage):
    """Ambiguous prefix (matches 2+ memories) returns None."""
    # Store two memories whose hashes share the same first character
    # by finding two and using only 1 char — highly likely to be ambiguous
    contents = [
        f"Ambiguity test memory alpha [{i}]" for i in range(20)
    ]
    hashes = []
    for c in contents:
        m = Memory(
            content=c,
            content_hash=generate_content_hash(c),
            tags=["__test__"],
            memory_type="note",
            metadata={},
        )
        await storage.store(m)
        hashes.append(m.content_hash)

    # Find a single hex digit that is a prefix of at least 2 stored hashes
    from collections import Counter
    first_chars = Counter(h[0] for h in hashes)
    ambiguous_char = next(
        (ch for ch, count in first_chars.items() if count >= 2), None
    )
    if ambiguous_char is None:
        pytest.skip("Could not generate ambiguous prefix with 20 memories")

    result = await storage.get_by_hash(ambiguous_char)
    assert result is None, "Ambiguous prefix should return None, not a random match"


# ---------------------------------------------------------------------------
# Layer 2: memory_service.get_memory_by_hash
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_memory_service_get_by_hash_found(storage, stored_memory):
    """MemoryService returns found=True and correct memory dict for full hash."""
    service = MemoryService(storage)
    result = await service.get_memory_by_hash(stored_memory.content_hash)
    assert result["found"] is True
    assert result["memory"]["content_hash"] == stored_memory.content_hash
    assert result["memory"]["content"] == stored_memory.content


@pytest.mark.asyncio
async def test_memory_service_get_by_hash_partial(storage, stored_memory):
    """MemoryService resolves unambiguous partial prefix."""
    service = MemoryService(storage)
    prefix = stored_memory.content_hash[:12]
    result = await service.get_memory_by_hash(prefix)
    assert result["found"] is True
    assert result["memory"]["content_hash"] == stored_memory.content_hash


@pytest.mark.asyncio
async def test_memory_service_get_by_hash_not_found(storage):
    """MemoryService returns found=False for unknown hash."""
    service = MemoryService(storage)
    result = await service.get_memory_by_hash("b" * 64)
    assert result["found"] is False


# ---------------------------------------------------------------------------
# Layer 3: handle_get_memory_by_hash MCP handler
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handler_get_memory_by_hash(storage, stored_memory):
    """MCP handler returns formatted TextContent for a valid hash."""
    service = MemoryService(storage)

    # Minimal mock server: handler only needs _ensure_storage_initialized + memory_service
    server = MagicMock()
    server._ensure_storage_initialized = AsyncMock(return_value=storage)
    server.memory_service = service

    result = await handle_get_memory_by_hash(
        server, {"content_hash": stored_memory.content_hash}
    )

    assert len(result) == 1
    text = result[0].text
    assert "Memory found" in text
    assert stored_memory.content_hash in text
    assert stored_memory.content in text
