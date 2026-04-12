"""
Genkit-style Embedder Implementation
Provides semantic embeddings using Google Gemini AI models
"""

import logging
import time
import hashlib
from typing import List, Optional, Dict, Any
from dataclasses import dataclass
from enum import Enum

import numpy as np
import google.generativeai as genai

from .genkit_config import ai_config

logger = logging.getLogger(__name__)

class EmbeddingTaskType(str, Enum):
    """Embedding task types for optimal model performance"""
    RETRIEVAL_QUERY = "retrieval_query"
    RETRIEVAL_DOCUMENT = "retrieval_document" 
    SEMANTIC_SIMILARITY = "semantic_similarity"
    CLASSIFICATION = "classification"

@dataclass
class EmbeddingResult:
    """Result from embedding generation"""
    embedding: np.ndarray
    model_used: str
    execution_time_ms: int
    token_count: Optional[int] = None
    success: bool = True
    error_message: Optional[str] = None

class GeminiEmbedder:
    """
    Genkit-style embedder using Google Gemini AI
    Provides semantic embeddings with fallback to hash-based embeddings
    """
    
    def __init__(self,
                 model_name: str = "gemini-embedding-2-preview",
                 dimension: int = 768,
                 enable_fallback: bool = True):
        """
        Initialize the Gemini embedder
        
        Args:
            model_name: Gemini embedding model to use
            dimension: Expected embedding dimension
            enable_fallback: Whether to use hash fallback on API failure
        """
        self.model_name = model_name
        self.dimension = dimension
        self.enable_fallback = enable_fallback
        
        # Statistics for debugging
        self.stats = {
            "total_requests": 0,
            "successful_requests": 0,
            "failed_requests": 0,
            "fallback_used": 0,
            "total_execution_time_ms": 0,
            "cache_hits": 0
        }
        
        # Simple in-memory cache for debugging
        self._cache = {}
        self._enable_cache = True
        
        logger.info(f"🧠 Initialized GeminiEmbedder with model: {model_name}")
    
    async def embed_text(self, 
                        text: str, 
                        task_type: EmbeddingTaskType = EmbeddingTaskType.RETRIEVAL_DOCUMENT) -> EmbeddingResult:
        """
        Generate embedding for a single text
        
        Args:
            text: Text to embed
            task_type: Type of embedding task for optimization
            
        Returns:
            EmbeddingResult with embedding vector and metadata
        """
        start_time = time.time()
        self.stats["total_requests"] += 1
        
        # Check cache first
        cache_key = self._get_cache_key(text, task_type)
        if self._enable_cache and cache_key in self._cache:
            self.stats["cache_hits"] += 1
            cached_result = self._cache[cache_key]
            logger.debug(f"🎯 Cache hit for text: {text[:50]}...")
            return EmbeddingResult(
                embedding=cached_result,
                model_used=f"{self.model_name} (cached)",
                execution_time_ms=0,
                success=True
            )
        
        logger.debug(f"🔍 Generating embedding for text: {text[:100]}...")
        
        # Try Gemini API first
        if ai_config.is_available():
            try:
                result = await self._generate_gemini_embedding(text, task_type)
                
                # Cache successful result
                if result.success and self._enable_cache:
                    self._cache[cache_key] = result.embedding
                
                execution_time = int((time.time() - start_time) * 1000)
                result.execution_time_ms = execution_time
                self.stats["total_execution_time_ms"] += execution_time
                
                if result.success:
                    self.stats["successful_requests"] += 1
                    logger.debug(f"✅ Gemini embedding generated in {execution_time}ms")
                    return result
                else:
                    self.stats["failed_requests"] += 1
                    logger.warning(f"⚠️ Gemini embedding failed: {result.error_message}. Falling back...")
                
            except Exception as e:
                logger.error(f"❌ Unexpected error in Gemini embedding: {e}")
                self.stats["failed_requests"] += 1
        
        # Fallback to hash-based embedding
        if self.enable_fallback:
            logger.warning(f"🔄 Using fallback embedding for: {text[:50]}...")
            fallback_embedding = self._create_fallback_embedding(text)
            self.stats["fallback_used"] += 1
            
            execution_time = int((time.time() - start_time) * 1000)
            self.stats["total_execution_time_ms"] += execution_time
            
            return EmbeddingResult(
                embedding=fallback_embedding,
                model_used="hash_fallback",
                execution_time_ms=execution_time,
                success=True,
                error_message="Used fallback due to API unavailability"
            )
        else:
            execution_time = int((time.time() - start_time) * 1000)
            return EmbeddingResult(
                embedding=np.zeros(self.dimension),
                model_used="none",
                execution_time_ms=execution_time,
                success=False,
                error_message="API unavailable and fallback disabled"
            )
    
    async def embed_batch(self, 
                         texts: List[str], 
                         task_type: EmbeddingTaskType = EmbeddingTaskType.RETRIEVAL_DOCUMENT) -> List[EmbeddingResult]:
        """
        Generate embeddings for multiple texts
        
        Args:
            texts: List of texts to embed
            task_type: Type of embedding task
            
        Returns:
            List of EmbeddingResult objects
        """
        logger.info(f"🔄 Generating embeddings for {len(texts)} texts")
        
        results = []
        for i, text in enumerate(texts):
            if i % 10 == 0:  # Log progress every 10 items
                logger.info(f"📊 Processing embedding {i+1}/{len(texts)}")
            
            result = await self.embed_text(text, task_type)
            results.append(result)
        
        successful = sum(1 for r in results if r.success)
        logger.info(f"✅ Completed batch embedding: {successful}/{len(texts)} successful")
        
        return results
    
    async def _generate_gemini_embedding(self,
                                       text: str,
                                       task_type: EmbeddingTaskType) -> EmbeddingResult:
        """Generate embedding via Gemini v1beta REST API.

        Uses requests directly so we can pass outputDimensionality=768,
        which keeps vectors compatible with the existing database schema.
        Available models on this endpoint: gemini-embedding-2-preview.
        """
        import os
        import requests as _requests

        _TASK_TYPE_MAP = {
            "retrieval_query":     "RETRIEVAL_QUERY",
            "retrieval_document":  "RETRIEVAL_DOCUMENT",
            "semantic_similarity": "SEMANTIC_SIMILARITY",
            "classification":      "CLASSIFICATION",
        }

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            return EmbeddingResult(
                embedding=np.zeros(self.dimension),
                model_used=self.model_name,
                execution_time_ms=0,
                success=False,
                error_message="GEMINI_API_KEY not set"
            )

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model_name}:embedContent?key={api_key}"
        )
        payload = {
            "model": f"models/{self.model_name}",
            "content": {"parts": [{"text": text}]},
            "taskType": _TASK_TYPE_MAP.get(task_type.value, "RETRIEVAL_DOCUMENT"),
            "outputDimensionality": self.dimension,
        }

        try:
            resp = _requests.post(url, json=payload, timeout=30)
            resp.raise_for_status()
            values = resp.json()["embedding"]["values"]
            embedding_vector = np.array(values, dtype=np.float32)

            if len(embedding_vector) != self.dimension:
                logger.warning(f"⚠️ Unexpected embedding dimension: {len(embedding_vector)} != {self.dimension}")
                if len(embedding_vector) < self.dimension:
                    embedding_vector = np.pad(embedding_vector, (0, self.dimension - len(embedding_vector)))
                else:
                    embedding_vector = embedding_vector[:self.dimension]

            return EmbeddingResult(
                embedding=embedding_vector,
                model_used=self.model_name,
                execution_time_ms=0,
                success=True
            )

        except Exception as e:
            error_msg = f"Gemini API error: {str(e)}"
            logger.error(f"❌ {error_msg}")
            return EmbeddingResult(
                embedding=np.zeros(self.dimension),
                model_used=self.model_name,
                execution_time_ms=0,
                success=False,
                error_message=error_msg
            )
    
    def _create_fallback_embedding(self, text: str) -> np.ndarray:
        """Create hash-based embedding as fallback"""
        # Use a combination of hashes for better distribution
        hash_md5 = hashlib.md5(text.lower().encode()).digest()
        hash_sha1 = hashlib.sha1(text.lower().encode()).digest()
        
        # Combine hashes
        combined = hash_md5 + hash_sha1
        
        # Convert to float array
        embedding = np.frombuffer(combined, dtype=np.uint8).astype(np.float32)
        
        # Pad or truncate to desired dimension
        if len(embedding) < self.dimension:
            # Repeat the pattern to fill dimension
            repeat_count = (self.dimension // len(embedding)) + 1
            embedding = np.tile(embedding, repeat_count)[:self.dimension]
        else:
            embedding = embedding[:self.dimension]
        
        # Normalize to unit vector
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        
        return embedding
    
    def _get_cache_key(self, text: str, task_type: EmbeddingTaskType) -> str:
        """Generate cache key for text and task type"""
        content = f"{text}:{task_type.value}"
        return hashlib.sha256(content.encode()).hexdigest()
    
    def get_stats(self) -> Dict[str, Any]:
        """Get embedding statistics for debugging"""
        avg_time = (self.stats["total_execution_time_ms"] / 
                   max(self.stats["total_requests"], 1))
        
        success_rate = (self.stats["successful_requests"] / 
                       max(self.stats["total_requests"], 1)) * 100
        
        return {
            **self.stats,
            "average_execution_time_ms": round(avg_time, 2),
            "success_rate_percent": round(success_rate, 2),
            "cache_size": len(self._cache),
            "model_name": self.model_name,
            "dimension": self.dimension,
            "fallback_enabled": self.enable_fallback
        }
    
    def clear_cache(self):
        """Clear the embedding cache"""
        self._cache.clear()
        self.stats["cache_hits"] = 0
        logger.info("🗑️ Embedding cache cleared")
    
    def disable_cache(self):
        """Disable caching for testing"""
        self._enable_cache = False
        logger.info("🚫 Embedding cache disabled")
    
    def enable_cache(self):
        """Enable caching"""
        self._enable_cache = True
        logger.info("✅ Embedding cache enabled")

# Global embedder instance
_embedder = None

def get_embedder() -> GeminiEmbedder:
    """Get the global embedder instance"""
    global _embedder
    if _embedder is None:
        _embedder = GeminiEmbedder()
    return _embedder

def initialize_embedder(model_name: str = "gemini-embedding-2-preview",
                       dimension: int = 768,
                       enable_fallback: bool = True) -> GeminiEmbedder:
    """Initialize the global embedder with custom settings"""
    global _embedder
    _embedder = GeminiEmbedder(model_name, dimension, enable_fallback)
    return _embedder
