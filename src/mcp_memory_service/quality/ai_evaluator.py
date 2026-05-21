"""
AI-powered quality evaluator with fallback chain.
Coordinates between local ONNX ranker and implicit signals.
"""

import logging
from typing import Optional
from .config import QualityConfig
from .onnx_ranker import get_onnx_ranker_model, ONNXRankerModel
from .implicit_signals import ImplicitSignalsEvaluator
from ..models.memory import Memory

logger = logging.getLogger(__name__)


class QualityEvaluator:
    """
    Multi-tier AI quality evaluator with fallback chain.
    Tries: Local ONNX → Implicit Signals
    """

    def __init__(self, config: Optional[QualityConfig] = None):
        """
        Initialize quality evaluator with configuration.

        Args:
            config: Quality configuration (defaults to env-based config)
        """
        self.config = config or QualityConfig.from_env()
        self.config.validate()

        # Initialize tier components
        self._onnx_ranker: Optional[ONNXRankerModel] = None
        self._onnx_models: dict = {}  # For fallback mode (multiple models)
        self._implicit_evaluator = ImplicitSignalsEvaluator()
        self._initialized = False

    def _ensure_initialized(self):
        """Lazy initialization of heavy components."""
        if self._initialized:
            return

        # Initialize local ONNX ranker(s) if using local provider
        if self.config.ai_provider in ['local', 'auto']:
            # Check if fallback mode enabled
            if self.config.fallback_enabled:
                # Load multiple models for fallback scoring
                try:
                    model_names = [m.strip() for m in self.config.local_model.split(',')]
                    logger.info(f"Loading {len(model_names)} models for fallback mode")

                    for model_name in model_names:
                        try:
                            model = get_onnx_ranker_model(
                                model_name=model_name,
                                device=self.config.local_device
                            )
                            if model:
                                self._onnx_models[model_name] = model
                                logger.info(f"✓ Loaded fallback model: {model_name}")
                        except Exception as e:
                            logger.warning(f"Failed to load model {model_name}: {e}")

                    if len(self._onnx_models) < 2:
                        logger.warning(
                            f"Fallback mode enabled but only {len(self._onnx_models)} models loaded. "
                            "Falling back to single model mode."
                        )
                        # Use first available model as single model fallback
                        if self._onnx_models:
                            self._onnx_ranker = list(self._onnx_models.values())[0]
                except Exception as e:
                    logger.error(f"Failed to initialize fallback models: {e}")
                    self._onnx_ranker = None
            else:
                # Single model mode (current behavior)
                try:
                    self._onnx_ranker = get_onnx_ranker_model(
                        model_name=self.config.local_model,
                        device=self.config.local_device
                    )
                    if self._onnx_ranker:
                        logger.info(f"ONNX ranker model initialized: {self.config.local_model}")
                except Exception as e:
                    logger.warning(f"Failed to initialize ONNX ranker: {e}")
                    self._onnx_ranker = None

        self._initialized = True

    async def evaluate_quality(self, query: str, memory: Memory) -> float:
        """
        Evaluate memory quality using multi-tier approach.

        Args:
            query: Search query for context
            memory: Memory object to evaluate

        Returns:
            Quality score between 0.0 and 1.0
        """
        self._ensure_initialized()

        if not self.config.enabled:
            # Quality system disabled, return neutral score
            return 0.5

        # Try tiers in order based on configuration
        provider_used = None
        score = None

        # Tier 1: Local ONNX (if available)
        if self.config.ai_provider in ['local', 'auto']:
            # Check if fallback mode enabled with multiple models
            if self.config.fallback_enabled and len(self._onnx_models) >= 2:
                try:
                    score, components = self._score_with_fallback(query, memory.content)
                    provider_used = 'fallback_deberta-msmarco'

                    # Store components in metadata for debugging
                    memory.metadata['quality_components'] = components

                    decision = components.get('decision', 'unknown')
                    deberta_s = components.get('deberta_score', 'N/A')
                    msmarco_s = components.get('ms_marco_score', 'N/A')

                    logger.info(
                        f"Fallback score: {score:.3f} ({decision}) - "
                        f"DeBERTa: {deberta_s}, MS-MARCO: {msmarco_s}"
                    )
                except Exception as e:
                    logger.error(f"Fallback scoring failed: {e}, falling back to single model")
                    score = None
            # Single model mode (existing code)
            elif self._onnx_ranker:
                try:
                    score = self._onnx_ranker.score_quality(query, memory.content)
                    provider_used = 'onnx_local'
                    logger.debug(f"Local ONNX score: {score:.3f}")
                except Exception as e:
                    logger.warning(f"ONNX scoring failed: {e}")
                    score = None
            else:
                score = None

        # Tier 2: Implicit signals (always available as fallback)
        if score is None:
            score = self._implicit_evaluator.evaluate_quality(memory, query)
            provider_used = 'implicit_signals'
            logger.debug(f"Implicit signals score: {score:.3f}")

        # Store provider information in memory metadata
        memory.metadata['quality_provider'] = provider_used

        return score

    def _score_with_fallback(
        self,
        query: str,
        memory_content: str
    ) -> tuple[float, dict]:
        """
        Score using fallback approach: DeBERTa primary, MS-MARCO rescue.

        Logic:
        1. Always score with DeBERTa first
        2. If DeBERTa >= threshold → use DeBERTa (confident)
        3. Else score with MS-MARCO:
           - If MS-MARCO >= threshold → use MS-MARCO (rescue technical content)
           - Else → use DeBERTa (both agree it's low)

        Args:
            query: Search query (may be empty for DeBERTa)
            memory_content: Memory content to score

        Returns:
            Tuple of (final_score, components_dict)
        """
        # Get model references
        deberta = self._onnx_models.get('nvidia-quality-classifier-deberta')
        ms_marco = self._onnx_models.get('ms-marco-MiniLM-L-6-v2')

        if not deberta:
            logger.error("DeBERTa model not loaded for fallback scoring")
            return 0.5, {'error': 'DeBERTa not available'}

        # Step 1: Always score with DeBERTa first
        try:
            deberta_score = deberta.score_quality("", memory_content)
            logger.debug(f"DeBERTa score: {deberta_score:.3f}")
        except Exception as e:
            logger.error(f"DeBERTa scoring failed: {e}")
            return 0.5, {'error': str(e)}

        # Step 2: If DeBERTa confident (high score), use it
        deberta_threshold = self.config.deberta_threshold
        if deberta_score >= deberta_threshold:
            logger.debug(
                f"DeBERTa confident ({deberta_score:.3f} >= {deberta_threshold}), using DeBERTa"
            )
            return deberta_score, {
                'final_score': deberta_score,
                'deberta_score': deberta_score,
                'ms_marco_score': None,
                'decision': 'deberta_confident'
            }

        # Step 3: DeBERTa scored low - try MS-MARCO rescue
        if not ms_marco:
            logger.warning("MS-MARCO not loaded, cannot rescue low DeBERTa score")
            return deberta_score, {
                'final_score': deberta_score,
                'deberta_score': deberta_score,
                'ms_marco_score': None,
                'decision': 'deberta_only'
            }

        try:
            # Use empty query to force absolute quality evaluation (not query-document relevance)
            # This avoids self-matching bias where content matches itself perfectly
            ms_marco_score = ms_marco.score_quality("", memory_content)
            logger.debug(f"MS-MARCO score: {ms_marco_score:.3f}")
        except Exception as e:
            logger.error(f"MS-MARCO scoring failed: {e}")
            return deberta_score, {
                'final_score': deberta_score,
                'deberta_score': deberta_score,
                'ms_marco_score': None,
                'decision': 'ms_marco_failed'
            }

        # Step 4: Check if MS-MARCO thinks it's good (technical content rescue)
        ms_marco_threshold = self.config.ms_marco_threshold
        if ms_marco_score >= ms_marco_threshold:
            logger.info(
                f"Technical content rescue: MS-MARCO {ms_marco_score:.3f} >= {ms_marco_threshold} "
                f"(DeBERTa was {deberta_score:.3f})"
            )
            return ms_marco_score, {
                'final_score': ms_marco_score,
                'deberta_score': deberta_score,
                'ms_marco_score': ms_marco_score,
                'decision': 'ms_marco_rescue'
            }

        # Step 5: Both agree it's low quality, use DeBERTa
        logger.debug(
            f"Both agree low quality: DeBERTa={deberta_score:.3f}, MS-MARCO={ms_marco_score:.3f}"
        )
        return deberta_score, {
            'final_score': deberta_score,
            'deberta_score': deberta_score,
            'ms_marco_score': ms_marco_score,
            'decision': 'both_low'
        }

