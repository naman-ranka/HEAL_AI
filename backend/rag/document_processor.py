"""
Document processing for RAG system
Handles text extraction, chunking, and storage
"""

import os
import logging
import uuid
import json
import pickle
from pathlib import Path
from typing import List, Dict, Any, Optional
from datetime import datetime

import fitz  # PyMuPDF
from PIL import Image
import pytesseract
import nltk
from nltk.tokenize import sent_tokenize, word_tokenize
import numpy as np

from database import get_db_connection
from ai.genkit_config import ai_config
from ai.embedder import get_embedder, EmbeddingTaskType

logger = logging.getLogger(__name__)

# Download required NLTK data
try:
    nltk.data.find('tokenizers/punkt')
except LookupError:
    nltk.download('punkt')

class DocumentChunk:
    """Represents a chunk of document text"""
    
    def __init__(self, text: str, chunk_index: int, chunk_type: str = "paragraph"):
        self.text = text
        self.chunk_index = chunk_index
        self.chunk_type = chunk_type
        self.embedding: Optional[np.ndarray] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "chunk_index": self.chunk_index,
            "chunk_type": self.chunk_type,
            "embedding": self.embedding.tolist() if self.embedding is not None else None
        }

class DocumentProcessor:
    """Handles document processing for RAG system"""
    
    def __init__(self, upload_dir: str = None):
        # UPLOAD_DIR lets deployments point originals at a persistent volume
        # (Railway's default filesystem is ephemeral). Defaults to ./uploads.
        self.upload_dir = Path(upload_dir or os.getenv("UPLOAD_DIR", "uploads"))
        self.upload_dir.mkdir(exist_ok=True)
    
    async def process_uploaded_file(
        self, 
        file_data: bytes, 
        filename: str, 
        mime_type: str,
        document_type: str = "policy"
    ) -> Dict[str, Any]:
        """
        Process uploaded file and store in RAG system
        
        Args:
            file_data: Raw file bytes
            filename: Original filename
            mime_type: MIME type of file
            document_type: Type of document ("policy", "bill", etc.)
            
        Returns:
            Processing result with document ID and stats
        """
        try:
            logger.info(f"🚀 Starting RAG document processing for {filename}")
            logger.info(f"📁 File size: {len(file_data)} bytes, MIME: {mime_type}")
            
            # Generate unique filename and save file
            file_id = str(uuid.uuid4())
            file_extension = Path(filename).suffix
            stored_filename = f"{file_id}{file_extension}"
            file_path = self.upload_dir / stored_filename
            
            logger.info(f"💾 Storing file as: {stored_filename}")
            
            # Save file to disk
            with open(file_path, 'wb') as f:
                f.write(file_data)
            
            # Store document metadata in database
            document_id = self._store_document_metadata(
                filename=stored_filename,
                file_path=str(file_path),
                original_name=filename,
                file_size=len(file_data),
                mime_type=mime_type,
                document_type=document_type
            )
            
            # Extract text based on file type
            logger.info(f"🔍 Starting text extraction for {mime_type}")
            try:
                if mime_type.startswith('image/'):
                    extracted_text = await self._extract_text_from_image(file_path)
                    document_type = 'image'
                    logger.info(f"🖼️ OCR completed, extracted {len(extracted_text)} chars")
                elif mime_type == 'application/pdf':
                    extracted_text = await self._extract_text_from_pdf(file_path)
                    document_type = 'pdf'
                    logger.info(f"📑 PDF text extraction completed, extracted {len(extracted_text)} chars")
                else:
                    raise ValueError(f"Unsupported file type: {mime_type}")
            except Exception as e:
                logger.error(f"❌ Text extraction failed: {e}")
                raise
            
            # Update document with extracted text
            logger.info(f"💾 Updating document in database with extracted text")
            self._update_document_text(document_id, extracted_text, document_type)
            
            # Chunk the text
            logger.info(f"✂️ Starting text chunking")
            try:
                chunks = self._chunk_text(extracted_text)
                logger.info(f"✅ Text chunking completed, created {len(chunks)} chunks")
            except Exception as e:
                logger.error(f"❌ Text chunking failed: {e}")
                raise
            
            # Generate embeddings and store chunks
            logger.info(f"🧠 Starting embedding generation for {len(chunks)} chunks")
            try:
                await self._process_chunks(document_id, chunks)
                logger.info(f"✅ Embedding generation completed")
            except Exception as e:
                logger.error(f"❌ Embedding generation failed: {e}")
                raise
            
            # Update processing status
            self._update_processing_status(document_id, 'processed', len(chunks))
            
            logger.info(f"✅ Successfully processed document {filename}")
            logger.info(f"📊 RAG Statistics - Chunks: {len(chunks)}, Text length: {len(extracted_text)} chars")
            logger.info(f"🎯 Processing status: processed")
            
            return {
                "document_id": document_id,
                "filename": filename,
                "chunks_created": len(chunks),
                "text_length": len(extracted_text),
                "processing_status": "processed"
            }
            
        except Exception as e:
            logger.error(f"Error processing document {filename}: {e}")
            if 'document_id' in locals():
                self._update_processing_status(document_id, 'failed', 0)
            raise
    
    async def _extract_text_from_image(self, file_path: Path) -> str:
        """Extract text from image using OCR"""
        try:
            image = Image.open(file_path)
            # Use pytesseract for OCR
            text = pytesseract.image_to_string(image)
            return text.strip()
        except Exception as e:
            logger.error(f"Error extracting text from image {file_path}: {e}")
            return ""
    
    async def _extract_text_from_pdf(self, file_path: Path) -> str:
        """Extract text from PDF"""
        try:
            doc = fitz.open(file_path)
            text = ""
            for page_num in range(doc.page_count):
                page = doc[page_num]
                text += f"\n--- Page {page_num + 1} ---\n"
                text += page.get_text()
            doc.close()
            return text.strip()
        except Exception as e:
            logger.error(f"Error extracting text from PDF {file_path}: {e}")
            return ""
    
    def _chunk_text(self, text: str, max_chunk_size: int = 750) -> List[DocumentChunk]:
        """
        Chunk text into smaller pieces for embedding
        
        Args:
            text: Input text to chunk
            max_chunk_size: Maximum words per chunk
            
        Returns:
            List of DocumentChunk objects
        """
        logger.info(f"📝 Starting text chunking for {len(text)} characters")
        
        if not text.strip():
            logger.warning("⚠️ Empty text provided for chunking")
            return []
        
        # Split into sentences
        logger.info("🔍 Tokenizing text into sentences")
        try:
            sentences = sent_tokenize(text)
            logger.info(f"✅ Found {len(sentences)} sentences")
        except Exception as e:
            logger.error(f"❌ Sentence tokenization failed: {e}")
            # Fallback to simple splitting
            sentences = text.split('. ')
            logger.info(f"🔄 Using fallback splitting, got {len(sentences)} segments")
        
        chunks = []
        current_chunk = ""
        chunk_index = 0
        
        logger.info(f"🔄 Processing {len(sentences)} sentences into chunks")
        overlap_sentences = 2  # Number of sentences to overlap between chunks
        
        for i, sentence in enumerate(sentences):
            if i % 100 == 0:  # Log progress every 100 sentences
                logger.info(f"📊 Processing sentence {i}/{len(sentences)}")
            
            # Count words in current chunk + new sentence
            try:
                words_in_chunk = len(word_tokenize(current_chunk)) if current_chunk else 0
                words_in_sentence = len(word_tokenize(sentence))
            except Exception as e:
                logger.warning(f"⚠️ Word tokenization failed for sentence {i}, using simple split: {e}")
                # Fallback to simple word counting
                words_in_chunk = len(current_chunk.split()) if current_chunk else 0
                words_in_sentence = len(sentence.split())
            
            if words_in_chunk + words_in_sentence <= max_chunk_size:
                # Add sentence to current chunk
                current_chunk += " " + sentence if current_chunk else sentence
            else:
                # Save current chunk and start new one with overlap
                if current_chunk.strip():
                    chunks.append(DocumentChunk(
                        text=current_chunk.strip(),
                        chunk_index=chunk_index,
                        chunk_type="paragraph"
                    ))
                    chunk_index += 1
                
                # Create overlap by keeping last few sentences
                chunk_sentences = current_chunk.split('. ')
                if len(chunk_sentences) > overlap_sentences:
                    overlap_text = '. '.join(chunk_sentences[-overlap_sentences:])
                    current_chunk = overlap_text + ". " + sentence
                else:
                    current_chunk = sentence
        
        # Add final chunk
        if current_chunk.strip():
            chunks.append(DocumentChunk(
                text=current_chunk.strip(),
                chunk_index=chunk_index,
                chunk_type="paragraph"
            ))
        
        return chunks
    
    async def _process_chunks(self, document_id: int, chunks: List[DocumentChunk]):
        """Generate embeddings and store chunks using real Gemini embeddings"""
        logger.info(f"🧠 Generating embeddings for {len(chunks)} chunks using Gemini")
        
        try:
            embedder = get_embedder()
            
            # Generate embeddings for all chunks
            for i, chunk in enumerate(chunks):
                logger.debug(f"📊 Processing chunk {i+1}/{len(chunks)}")
                
                try:
                    # Generate real semantic embedding
                    embedding_result = await embedder.embed_text(
                        text=chunk.text,
                        task_type=EmbeddingTaskType.RETRIEVAL_DOCUMENT
                    )
                    
                    if embedding_result.success:
                        chunk.embedding = embedding_result.embedding
                        logger.debug(f"✅ Generated {embedding_result.model_used} embedding for chunk {i+1}")
                    else:
                        logger.warning(f"⚠️ Embedding failed for chunk {i+1}: {embedding_result.error_message}")
                        chunk.embedding = None
                        
                except Exception as e:
                    logger.error(f"❌ Unexpected error generating embedding for chunk {i+1}: {e}")
                    chunk.embedding = None
            
            # Store chunks in database
            self._store_chunks(document_id, chunks)
            
            # Log embedding statistics
            stats = embedder.get_stats()
            logger.info(f"📈 Embedding stats - Success rate: {stats['success_rate_percent']:.1f}%, "
                       f"Avg time: {stats['average_execution_time_ms']:.1f}ms, "
                       f"Fallback used: {stats['fallback_used']} times")
            
        except Exception as e:
            logger.error(f"❌ Error processing chunks for document {document_id}: {e}")
            raise
    
    def _store_document_metadata(
        self, 
        filename: str, 
        file_path: str, 
        original_name: str,
        file_size: int,
        mime_type: str,
        document_type: str = "policy"
    ) -> int:
        """Store document metadata in database"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO documents (
                    filename, file_path, original_name, file_size, mime_type, document_type
                ) VALUES (?, ?, ?, ?, ?, ?)
            """, (filename, file_path, original_name, file_size, mime_type, document_type))
            
            document_id = cursor.lastrowid
            conn.commit()
            return document_id
        finally:
            conn.close()
    
    def _update_document_text(self, document_id: int, text: str, document_type: str):
        """Update document with extracted text"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE documents 
                SET extracted_text = ?, document_type = ?
                WHERE id = ?
            """, (text, document_type, document_id))
            conn.commit()
        finally:
            conn.close()
    
    def _store_chunks(self, document_id: int, chunks: List[DocumentChunk]):
        """Store chunks with embeddings in database"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            for chunk in chunks:
                # Serialize embedding
                embedding_blob = pickle.dumps(chunk.embedding) if chunk.embedding is not None else None
                
                cursor.execute("""
                    INSERT INTO document_chunks (
                        document_id, chunk_text, chunk_index, chunk_type, embedding
                    ) VALUES (?, ?, ?, ?, ?)
                """, (
                    document_id,
                    chunk.text,
                    chunk.chunk_index,
                    chunk.chunk_type,
                    embedding_blob
                ))
            conn.commit()
        finally:
            conn.close()
    
    def _update_processing_status(self, document_id: int, status: str, chunk_count: int):
        """Update document processing status"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE documents 
                SET processing_status = ?, chunk_count = ?
                WHERE id = ?
            """, (status, chunk_count, document_id))
            conn.commit()
        finally:
            conn.close()
    
    def get_document_info(self, document_id: int) -> Optional[Dict[str, Any]]:
        """Get document information"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM documents WHERE id = ?
            """, (document_id,))
            
            row = cursor.fetchone()
            if row:
                return dict(row)
            return None
        finally:
            conn.close()
    
    def list_documents(self) -> List[Dict[str, Any]]:
        """List all documents"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, original_name, document_type, processing_status, 
                       chunk_count, upload_timestamp, file_size
                FROM documents 
                ORDER BY upload_timestamp DESC
            """)
            
            return [dict(row) for row in cursor.fetchall()]
        finally:
            conn.close()
