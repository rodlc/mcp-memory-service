"""
Heuristic quality scorer for memory evaluation.
Zero-dependency, language-neutral, instant scoring.
Combines content signals (50%) with usage signals (50%).
"""

import math
import re
import time
from ..models.memory import Memory


STRUCTURE_PATTERNS = [
    (r"\n", 0.03),
    (r"[\-\*] ", 0.05),
    (r"#+\s", 0.05),
    (r"\w+:\s", 0.04),
    (r"```", 0.04),
    (r"https?://", 0.02),
    (r"\d{4}[-/]\d{2}", 0.02),
]

TYPE_WEIGHTS = {
    "convention": 0.15,
    "procedural": 0.12,
    "critical": 0.15,
    "reference": 0.12,
    "semantic": 0.10,
    "episodic": 0.08,
    "meta": 0.10,
    "condense": 0.10,
    "session-stub": 0.06,
    "standard": 0.05,
    "note": 0.05,
    "association": 0.02,
    "compressed_cluster": 0.03,
}


class HeuristicScorer:
    """Content + usage quality scorer. No ML model, no RAM overhead."""

    def score(self, memory: Memory) -> float:
        content_score = self._score_content(memory)
        usage_score = self._score_usage(memory)
        return max(0.0, min(1.0, content_score * 0.5 + usage_score * 0.5))

    def _score_content(self, memory: Memory) -> float:
        content = memory.content or ""
        tags = memory.tags or []
        memory_type = memory.memory_type or (memory.metadata or {}).get("memory_type", "standard")
        score = 0.0

        length = len(content)
        if length < 20:
            score += 0.02
        elif length < 50:
            score += 0.08
        elif length < 150:
            score += 0.15
        elif length < 400:
            score += 0.20
        elif length < 1000:
            score += 0.25
        else:
            score += 0.30

        struct = 0.0
        for pattern, w in STRUCTURE_PATTERNS:
            if re.search(pattern, content):
                struct += w
        score += min(0.25, struct)

        words = content.split()
        if len(words) > 5:
            unique_ratio = len(set(w.lower() for w in words)) / len(words)
            score += unique_ratio * 0.15
        else:
            score += 0.02

        score += min(0.15, len(tags) * 0.03)

        score += TYPE_WEIGHTS.get(memory_type, 0.05)

        return min(1.0, score)

    def _score_usage(self, memory: Memory) -> float:
        metadata = memory.metadata or {}

        access_count = metadata.get("access_count", 0)
        access_score = min(1.0, math.log(access_count + 1) / math.log(100))

        last_accessed_at = metadata.get("last_accessed_at")
        if last_accessed_at is not None:
            days_since = (time.time() - last_accessed_at) / 86400
            recency_score = math.exp(-0.1 * days_since)
        else:
            recency_score = 0.1

        avg_ranking = metadata.get("avg_ranking", 0.5)
        ranking_score = 1.0 - avg_ranking

        user_rating = metadata.get("user_rating")
        if user_rating is not None:
            rating_score = min(1.0, user_rating / 5.0)
        else:
            rating_score = 0.5

        return (
            access_score * 0.30
            + recency_score * 0.25
            + ranking_score * 0.20
            + rating_score * 0.25
        )
