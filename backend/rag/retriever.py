"""
RAG retrieval system for finding relevant document chunks
"""

import logging
import json
import pickle
import time
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

from database import get_db_connection
from ai.genkit_config import ai_config
from ai.embedder import get_embedder, EmbeddingTaskType

logger = logging.getLogger(__name__)

@dataclass
class RetrievedChunk:
    """Represents a retrieved document chunk with similarity score"""
    chunk_id: int
    document_id: int
    text: str
    similarity_score: float
    chunk_index: int
    chunk_type: str
    source_document: str

@dataclass
class RetrievalResult:
    """Result of RAG retrieval operation"""
    query: str
    chunks: List[RetrievedChunk]
    total_found: int
    execution_time_ms: int
    query_embedding: Optional[np.ndarray] = None

class RAGRetriever:
    """Handles retrieval of relevant document chunks for queries"""
    
    def __init__(self):
        self.embedding_cache = {}  # Cache embeddings in memory
    
    async def retrieve(
        self, 
        query: str, 
        top_k: int = 5,
        similarity_threshold: float = 0.1,
        document_ids: Optional[List[int]] = None
    ) -> RetrievalResult:
        """
        Retrieve relevant chunks for a query
        
        Args:
            query: Search query
            top_k: Number of top results to return
            similarity_threshold: Minimum similarity score
            document_ids: Optional list of document IDs to search within
            
        Returns:
            RetrievalResult with relevant chunks
        """
        start_time = time.time()
        
        try:
            # Generate query embedding
            logger.info(f"🔍 RAG Query: '{query}' with document_ids={document_ids}")
            query_embedding = await self._generate_query_embedding(query)
            logger.info(f"📊 Generated query embedding with shape: {query_embedding.shape}")
            
            # Get all chunk embeddings from database
            chunks_data = self._get_chunks_with_embeddings(document_ids)
            logger.info(f"📚 Found {len(chunks_data)} chunks in database")
            
            if not chunks_data:
                logger.warning("No chunks found in database")
                return RetrievalResult(
                    query=query,
                    chunks=[],
                    total_found=0,
                    execution_time_ms=int((time.time() - start_time) * 1000),
                    query_embedding=query_embedding
                )
            
            # Filter chunks to only those with valid embeddings matching query dimensions
            query_dim = query_embedding.shape[0]
            valid_chunks = []
            
            for chunk in chunks_data:
                embedding = chunk['embedding']
                if embedding is not None and embedding.shape[0] == query_dim:
                    valid_chunks.append(chunk)
                else:
                    logger.warning(f"❌ Skipping chunk {chunk.get('chunk_id', 'unknown')} - embedding shape mismatch: {embedding.shape if embedding is not None else 'None'} vs query {query_dim}")
            
            logger.info(f"✅ Using {len(valid_chunks)} valid chunks out of {len(chunks_data)} total")
            
            if not valid_chunks:
                logger.warning("No chunks with matching embedding dimensions found")
                return RetrievalResult(
                    query=query,
                    chunks=[],
                    total_found=0,
                    execution_time_ms=int((time.time() - start_time) * 1000)
                )
            
            # Calculate similarities using only valid chunks
            similarities = self._calculate_similarities(query_embedding, valid_chunks)
            
            # Filter and sort results
            relevant_chunks = []
            for i, (chunk_data, similarity) in enumerate(zip(valid_chunks, similarities)):
                if similarity >= similarity_threshold:
                    relevant_chunks.append(RetrievedChunk(
                        chunk_id=chunk_data['chunk_id'],
                        document_id=chunk_data['document_id'],
                        text=chunk_data['chunk_text'],
                        similarity_score=float(similarity),
                        chunk_index=chunk_data['chunk_index'],
                        chunk_type=chunk_data['chunk_type'],
                        source_document=chunk_data['original_name']
                    ))
            
            # Sort by similarity score (descending)
            relevant_chunks.sort(key=lambda x: x.similarity_score, reverse=True)
            
            # Take top k results
            top_chunks = relevant_chunks[:top_k]
            
            execution_time = int((time.time() - start_time) * 1000)
            
            # Store query for debugging
            self._store_query_debug_info(query, query_embedding, top_chunks, execution_time)
            
            logger.info(f"Retrieved {len(top_chunks)} chunks for query '{query[:50]}...' in {execution_time}ms")
            
            return RetrievalResult(
                query=query,
                chunks=top_chunks,
                total_found=len(relevant_chunks),
                execution_time_ms=execution_time,
                query_embedding=query_embedding
            )
            
        except Exception as e:
            logger.error(f"Error during retrieval for query '{query}': {e}")
            execution_time = int((time.time() - start_time) * 1000)
            return RetrievalResult(
                query=query,
                chunks=[],
                total_found=0,
                execution_time_ms=execution_time
            )
    
    async def _generate_query_embedding(self, query: str) -> np.ndarray:
        """Generate embedding for query text using real Gemini embeddings"""
        logger.debug(f"🔍 Generating query embedding for: {query[:50]}...")
        
        try:
            embedder = get_embedder()
            
            # Generate real semantic embedding for query
            embedding_result = await embedder.embed_text(
                text=query,
                task_type=EmbeddingTaskType.RETRIEVAL_QUERY
            )
            
            if embedding_result.success:
                logger.debug(f"✅ Generated {embedding_result.model_used} query embedding in {embedding_result.execution_time_ms}ms")
                return embedding_result.embedding
            else:
                logger.warning(f"⚠️ Query embedding failed: {embedding_result.error_message}")
                return self._create_simple_embedding(query)
                
        except Exception as e:
            logger.error(f"❌ Error generating query embedding: {e}")
            return self._create_simple_embedding(query)
    
    def _create_simple_embedding(self, text: str, dim: int = 768) -> np.ndarray:
        """Create a simple hash-based embedding as fallback"""
        import hashlib
        hash_obj = hashlib.md5(text.lower().encode())  # Lowercase for consistency
        hash_bytes = hash_obj.digest()
        
        # Convert to float array and normalize
        embedding = np.frombuffer(hash_bytes, dtype=np.uint8).astype(np.float32)
        
        # Pad or truncate to desired dimension
        if len(embedding) < dim:
            embedding = np.pad(embedding, (0, dim - len(embedding)))
        else:
            embedding = embedding[:dim]
        
        # Normalize
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        
        return embedding
    
    def _get_chunks_with_embeddings(self, document_ids: Optional[List[int]] = None) -> List[Dict[str, Any]]:
        """Get chunks with their embeddings from database"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            
            if document_ids:
                placeholders = ','.join('?' * len(document_ids))
                query = f"""
                    SELECT 
                        dc.id as chunk_id,
                        dc.document_id,
                        dc.chunk_text,
                        dc.chunk_index,
                        dc.chunk_type,
                        dc.embedding,
                        d.original_name
                    FROM document_chunks dc
                    JOIN documents d ON dc.document_id = d.id
                    WHERE dc.document_id IN ({placeholders})
                    AND dc.embedding IS NOT NULL
                """
                cursor.execute(query, document_ids)
            else:
                cursor.execute("""
                    SELECT 
                        dc.id as chunk_id,
                        dc.document_id,
                        dc.chunk_text,
                        dc.chunk_index,
                        dc.chunk_type,
                        dc.embedding,
                        d.original_name
                    FROM document_chunks dc
                    JOIN documents d ON dc.document_id = d.id
                    WHERE dc.embedding IS NOT NULL
                """)
            
            chunks_data = []
            for row in cursor.fetchall():
                row_dict = dict(row)
                # Deserialize embedding
                if row_dict['embedding']:
                    try:
                        row_dict['embedding'] = pickle.loads(row_dict['embedding'])
                        chunks_data.append(row_dict)
                    except Exception as e:
                        logger.warning(f"Failed to deserialize embedding for chunk {row_dict['chunk_id']}: {e}")
            
            return chunks_data
            
        finally:
            conn.close()
    
    def _calculate_similarities(
        self, 
        query_embedding: np.ndarray, 
        chunks_data: List[Dict[str, Any]]
    ) -> np.ndarray:
        """Calculate cosine similarities between query and chunk embeddings"""
        
        if not chunks_data:
            return np.array([])
        
        # Extract embeddings from pre-filtered chunks (already validated)
        chunk_embeddings = np.stack([chunk['embedding'] for chunk in chunks_data])
        
        # Calculate cosine similarities
        query_embedding_2d = query_embedding.reshape(1, -1)
        similarities = cosine_similarity(query_embedding_2d, chunk_embeddings)[0]
        
        return similarities
    
    def _store_query_debug_info(
        self, 
        query: str, 
        query_embedding: np.ndarray,
        top_chunks: List[RetrievedChunk],
        execution_time: int
    ):
        """Store query information for debugging"""
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Serialize query embedding
            embedding_blob = pickle.dumps(query_embedding)
            
            # Prepare top chunks info
            chunks_info = [
                {
                    "chunk_id": chunk.chunk_id,
                    "similarity_score": chunk.similarity_score,
                    "text_preview": chunk.text[:100] + "..." if len(chunk.text) > 100 else chunk.text,
                    "source": chunk.source_document
                }
                for chunk in top_chunks
            ]
            
            cursor.execute("""
                INSERT INTO rag_queries (
                    query_text, embedding, top_chunks, execution_time_ms
                ) VALUES (?, ?, ?, ?)
            """, (
                query,
                embedding_blob,
                json.dumps(chunks_info),
                execution_time
            ))
            
            conn.commit()
            conn.close()
            
        except Exception as e:
            logger.error(f"Error storing query debug info: {e}")
    
    def search_chunks_by_text(
        self, 
        search_text: str, 
        document_ids: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """Simple text-based search for debugging"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            
            search_pattern = f"%{search_text}%"
            
            if document_ids:
                placeholders = ','.join('?' * len(document_ids))
                query = f"""
                    SELECT 
                        dc.id as chunk_id,
                        dc.document_id,
                        dc.chunk_text,
                        dc.chunk_index,
                        dc.chunk_type,
                        d.original_name
                    FROM document_chunks dc
                    JOIN documents d ON dc.document_id = d.id
                    WHERE dc.chunk_text LIKE ?
                    AND dc.document_id IN ({placeholders})
                    ORDER BY dc.chunk_index
                """
                cursor.execute(query, [search_pattern] + document_ids)
            else:
                cursor.execute("""
                    SELECT 
                        dc.id as chunk_id,
                        dc.document_id,
                        dc.chunk_text,
                        dc.chunk_index,
                        dc.chunk_type,
                        d.original_name
                    FROM document_chunks dc
                    JOIN documents d ON dc.document_id = d.id
                    WHERE dc.chunk_text LIKE ?
                    ORDER BY dc.chunk_index
                """, (search_pattern,))
            
            return [dict(row) for row in cursor.fetchall()]
            
        finally:
            conn.close()
    
    def get_retrieval_stats(self) -> Dict[str, Any]:
        """Get statistics about the retrieval system"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            
            # Count documents and chunks
            cursor.execute("SELECT COUNT(*) FROM documents WHERE processing_status = 'processed'")
            processed_docs = cursor.fetchone()[0]
            
            cursor.execute("SELECT COUNT(*) FROM document_chunks WHERE embedding IS NOT NULL")
            embedded_chunks = cursor.fetchone()[0]
            
            cursor.execute("SELECT COUNT(*) FROM rag_queries")
            total_queries = cursor.fetchone()[0]
            
            # Average execution time
            cursor.execute("SELECT AVG(execution_time_ms) FROM rag_queries")
            avg_execution_time = cursor.fetchone()[0] or 0
            
            return {
                "processed_documents": processed_docs,
                "embedded_chunks": embedded_chunks,
                "total_queries": total_queries,
                "average_execution_time_ms": round(avg_execution_time, 2)
            }
            
        finally:
            conn.close()
