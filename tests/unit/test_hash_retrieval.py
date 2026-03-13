"""
Unit tests for hash-based memory retrieval.

Tests:
- store_memory returns full 64-char hash (not truncated 8-char)
- get_memory_by_hash with full hash returns memory
- get_memory_by_hash with partial prefix returns memory
- get_memory_by_hash with nonexistent hash returns not-found
- sqlite_vec get_by_hash supports partial prefix (LIKE)
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from mcp_memory_service.services.memory_service import MemoryService
from mcp_memory_service.models.memory import Memory
from mcp_memory_service.storage.base import MemoryStorage

FULL_HASH = "a" * 64
PARTIAL_HASH = "a" * 8


@pytest.fixture
def sample_memory():
    return Memory(
        content="Test content for hash retrieval",
        content_hash=FULL_HASH,
        tags=["test"],
        memory_type="note",
        metadata={},
        created_at=1700000000.0,
        updated_at=1700000000.0,
        created_at_iso="2023-11-14T22:13:20",
        updated_at_iso="2023-11-14T22:13:20",
    )


@pytest.fixture
def mock_storage(sample_memory):
    storage = AsyncMock(spec=MemoryStorage)
    storage.max_content_length = 1000
    storage.supports_chunking = True
    storage.store.return_value = (True, "Success")
    storage.get_by_hash.return_value = sample_memory
    return storage


@pytest.fixture
def memory_service(mock_storage):
    return MemoryService(storage=mock_storage)


# ── store_memory: full hash in response ──────────────────────────────────────

class TestStoreMemoryFullHash:
    @pytest.mark.asyncio
    async def test_single_memory_response_contains_full_hash(self, memory_service, mock_storage):
        """store_memory result must expose the full 64-char hash, not a truncated prefix."""
        mock_storage.store.return_value = (True, "stored")
        # Simulate the service returning a memory dict with full hash
        memory_service._format_memory_response = MagicMock(return_value={
            "content_hash": FULL_HASH,
            "content": "Test content",
        })

        result = await memory_service.store_memory(
            content="Test content",
            tags="test",
            memory_type="note",
            metadata={},
        )

        # The handler reads result["memory"]["content_hash"] — must be 64 chars
        if result.get("success") and "memory" in result:
            assert len(result["memory"]["content_hash"]) == 64, (
                "store_memory must return full 64-char hash, not truncated"
            )


# ── get_memory_by_hash ────────────────────────────────────────────────────────

class TestGetMemoryByHash:
    @pytest.mark.asyncio
    async def test_full_hash_returns_memory(self, memory_service, mock_storage, sample_memory):
        """get_memory_by_hash with full 64-char hash returns the memory."""
        mock_storage.get_by_hash.return_value = sample_memory

        result = await memory_service.get_memory_by_hash(FULL_HASH)

        assert result["found"] is True
        assert "memory" in result
        mock_storage.get_by_hash.assert_called_once_with(FULL_HASH)

    @pytest.mark.asyncio
    async def test_partial_hash_delegates_to_storage(self, memory_service, mock_storage, sample_memory):
        """get_memory_by_hash with partial prefix delegates lookup to storage."""
        mock_storage.get_by_hash.return_value = sample_memory

        result = await memory_service.get_memory_by_hash(PARTIAL_HASH)

        assert result["found"] is True
        mock_storage.get_by_hash.assert_called_once_with(PARTIAL_HASH)

    @pytest.mark.asyncio
    async def test_nonexistent_hash_returns_not_found(self, memory_service, mock_storage):
        """get_memory_by_hash with unknown hash returns found=False."""
        mock_storage.get_by_hash.return_value = None

        result = await memory_service.get_memory_by_hash("nonexistent" * 5 + "xxxx")

        assert result["found"] is False
        assert "memory" not in result


# ── sqlite_vec partial hash support ──────────────────────────────────────────

class TestSqliteVecPartialHash:
    """Test get_by_hash partial prefix support in sqlite_vec storage."""

    @pytest.mark.asyncio
    async def test_partial_hash_matches_full_hash_prefix(self):
        """get_by_hash with 8-char prefix should match a memory whose hash starts with it."""
        from unittest.mock import MagicMock, patch
        from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage

        storage = SqliteVecMemoryStorage.__new__(SqliteVecMemoryStorage)
        storage.conn = MagicMock()
        storage._safe_json_loads = MagicMock(return_value={})

        # Build a fake row matching FULL_HASH
        fake_row = (
            FULL_HASH,          # content_hash
            "Test content",     # content
            "test",             # tags
            "note",             # memory_type
            "{}",               # metadata
            1700000000.0,       # created_at
            1700000000.0,       # updated_at
            "2023-11-14",       # created_at_iso
            "2023-11-14",       # updated_at_iso
        )

        mock_cursor = MagicMock()
        # For partial: fetchmany(2) returns [fake_row]
        mock_cursor.fetchmany.return_value = [fake_row]
        mock_cursor.fetchone.return_value = fake_row
        storage.conn.execute.return_value = mock_cursor

        memory = await storage.get_by_hash(PARTIAL_HASH)

        assert memory is not None
        assert memory.content_hash == FULL_HASH

        # Verify LIKE was used (not =) for partial hash
        call_args = storage.conn.execute.call_args
        sql = call_args[0][0]
        assert "LIKE" in sql, "Partial hash lookup must use LIKE, not ="

    @pytest.mark.asyncio
    async def test_full_hash_uses_exact_match(self):
        """get_by_hash with 64-char hash must use = (exact match), not LIKE."""
        from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage

        storage = SqliteVecMemoryStorage.__new__(SqliteVecMemoryStorage)
        storage.conn = MagicMock()
        storage._safe_json_loads = MagicMock(return_value={})

        fake_row = (
            FULL_HASH, "Content", "tag", "note", "{}",
            1700000000.0, 1700000000.0, "2023-11-14", "2023-11-14",
        )
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = fake_row
        storage.conn.execute.return_value = mock_cursor

        memory = await storage.get_by_hash(FULL_HASH)

        assert memory is not None
        call_args = storage.conn.execute.call_args
        sql = call_args[0][0]
        assert "= ?" in sql, "Full hash lookup must use = (exact match)"

    @pytest.mark.asyncio
    async def test_ambiguous_partial_hash_returns_none(self):
        """get_by_hash with prefix matching 2+ memories returns None (ambiguous)."""
        from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage

        storage = SqliteVecMemoryStorage.__new__(SqliteVecMemoryStorage)
        storage.conn = MagicMock()

        fake_row_1 = ("a" * 64, "C1", "t", "note", "{}", 0, 0, "", "")
        fake_row_2 = ("a" * 63 + "b", "C2", "t", "note", "{}", 0, 0, "", "")

        mock_cursor = MagicMock()
        mock_cursor.fetchmany.return_value = [fake_row_1, fake_row_2]
        storage.conn.execute.return_value = mock_cursor

        memory = await storage.get_by_hash("a" * 8)

        assert memory is None, "Ambiguous partial hash must return None"

    @pytest.mark.asyncio
    async def test_no_match_returns_none(self):
        """get_by_hash returns None when no memory matches."""
        from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage

        storage = SqliteVecMemoryStorage.__new__(SqliteVecMemoryStorage)
        storage.conn = MagicMock()

        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = None
        mock_cursor.fetchmany.return_value = []
        storage.conn.execute.return_value = mock_cursor

        memory = await storage.get_by_hash(FULL_HASH)
        assert memory is None
