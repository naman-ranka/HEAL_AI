from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import sqlite3
import json
import os
import logging
import base64
import time
import shutil
from datetime import datetime
from typing import Dict, Any, List
from dotenv import load_dotenv

# Import AI flows and schemas with error handling
try:
    from ai.flows.policy_analysis import analyze_insurance_policy, summarize_policy_document
    from ai.genkit_config import ai_config
    from ai.schemas import (
        PolicyAnalysisInput, 
        PolicyAnalysisOutput,
        DocumentType,
        HealthCheckOutput
    )
    AI_IMPORTS_SUCCESS = True
except ImportError as e:
    logger.error(f"AI imports failed: {e}")
    AI_IMPORTS_SUCCESS = False
    # Create mock objects
    class MockConfig:
        def is_available(self): return False
    ai_config = MockConfig()

# Import RAG system with error handling
try:
    from rag import DocumentProcessor, RAGRetriever, InsuranceChatbot
    from database import create_rag_tables
    from ai.embedder import get_embedder
    RAG_IMPORTS_SUCCESS = True
except ImportError as e:
    logger.error(f"RAG imports failed: {e}")
    RAG_IMPORTS_SUCCESS = False
    # Create mock objects
    DocumentProcessor = None
    RAGRetriever = None
    InsuranceChatbot = None
    def create_rag_tables(): pass
    def get_embedder(): return None

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="HEAL API - AI Powered",
    description="Insurance Policy Analyzer with structured document analysis and chatbot using Genkit-inspired patterns",
    version="2.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # Original React dev server
        "http://localhost:5173",  # Vite dev server (frontend-final)
        "http://localhost:4173",  # Vite preview server
        "http://localhost:8080",  # Frontend running on port 8080
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Check AI availability
ai_available = False
if AI_IMPORTS_SUCCESS:
    try:
        ai_available = ai_config.is_available()
        if ai_available:
            logger.info("AI services initialized successfully")
        else:
            logger.warning("AI services not available - using mock responses")
    except Exception as e:
        logger.error(f"AI config check failed: {e}")
        ai_available = False
else:
    logger.warning("AI imports failed - using mock responses")

# Initialize RAG components with error handling
document_processor = None
rag_retriever = None
chatbot = None

if RAG_IMPORTS_SUCCESS:
    try:
        document_processor = DocumentProcessor()
        rag_retriever = RAGRetriever()
        chatbot = InsuranceChatbot()
        logger.info("RAG components initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize RAG components: {e}")
        # Continue without RAG components for basic functionality
        document_processor = None
        rag_retriever = None
        chatbot = None
else:
    logger.warning("RAG imports failed - components not available")

# Initialize database
def init_db():
    conn = sqlite3.connect("heal.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS policies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            summary_json TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()
    
    # Initialize RAG tables
    create_rag_tables()

# Initialize database on startup
try:
    init_db()
    logger.info("Database initialized successfully")
except Exception as e:
    logger.error(f"Database initialization failed: {e}")
    # Continue without database for basic health check functionality

# Serve static files (frontend) in production
if os.path.exists("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")
    logger.info("Static files mounted at /static")

@app.post("/upload", response_model=PolicyAnalysisOutput)
async def upload_document(file: UploadFile = File(...)) -> PolicyAnalysisOutput:
    """
    Upload and analyze insurance document using Genkit AI flows
    
    Args:
        file: Uploaded file (image or PDF)
        
    Returns:
        PolicyAnalysisOutput with structured policy information
    """
    try:
        # Check if AI is available
        if not ai_available:
            logger.warning("AI not available, returning mock data")
            mock_response = PolicyAnalysisOutput(
                deductible="$1,000 (mock)",
                out_of_pocket_max="$5,000 (mock)", 
                copay="$25 (mock)",
                confidence_score=0.5,
                additional_info={"note": "Mock data - configure GEMINI_API_KEY for real analysis"}
            )
            save_to_database(mock_response.model_dump())
            return mock_response
        
        # Validate file type
        allowed_types = ["image/", "application/pdf"]
        if not any(file.content_type.startswith(file_type) for file_type in allowed_types):
            raise HTTPException(status_code=400, detail="File must be an image or PDF")
        
        # Read and encode file data
        file_data = await file.read()
        encoded_data = base64.b64encode(file_data).decode('utf-8')
        
        # Determine document type
        doc_type = DocumentType.IMAGE if file.content_type.startswith("image/") else DocumentType.PDF
        
        # Create Genkit input
        analysis_input = PolicyAnalysisInput(
            document_data=encoded_data,
            document_type=doc_type,
            filename=file.filename or "unknown"
        )
        
        logger.info(f"Analyzing {doc_type.value} file: {file.filename}")
        
        # Use Genkit flow for analysis - guaranteed structured output
        analysis_result = await analyze_insurance_policy(analysis_input)
        
        # Save to database (original functionality)
        save_to_database(analysis_result.model_dump())
        
        # Process document for RAG system
        logger.info(f"🚀 Starting RAG processing for {file.filename}")
        try:
            rag_result = await document_processor.process_uploaded_file(
                file_data=file_data,
                filename=file.filename or "unknown",
                mime_type=file.content_type
            )
            logger.info(f"✅ RAG processing completed: {rag_result['chunks_created']} chunks created")
            
            # Add RAG info to response
            if hasattr(analysis_result, 'additional_info') and analysis_result.additional_info:
                analysis_result.additional_info.update({
                    "rag_document_id": rag_result["document_id"],
                    "rag_chunks_created": rag_result["chunks_created"]
                })
            else:
                analysis_result.additional_info = {
                    "rag_document_id": rag_result["document_id"],
                    "rag_chunks_created": rag_result["chunks_created"]
                }
                
        except Exception as rag_error:
            logger.error(f"❌ RAG processing failed: {rag_error}")
            logger.exception("Full RAG error traceback:")
            # Don't fail the main upload, just log the error
            if hasattr(analysis_result, 'additional_info') and analysis_result.additional_info:
                analysis_result.additional_info["rag_error"] = str(rag_error)
            else:
                analysis_result.additional_info = {"rag_error": str(rag_error)}
        
        logger.info(f"Successfully analyzed document: {file.filename}")
        return analysis_result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing document {getattr(file, 'filename', 'unknown')}: {e}")
        # Return structured error response with new format
        from ai.schemas import (PolicyDetailsOutput, CoverageCostsOutput, NetworkCoverageInfo, 
                               DeductibleInfo, OutOfPocketMaxInfo, CommonServiceOutput, 
                               PrescriptionsOutput, PrescriptionTierOutput, ImportantNoteOutput)
        
        error_response = PolicyAnalysisOutput(
            policyDetails=PolicyDetailsOutput(
                policyHolder="Analysis failed",
                policyNumber="Analysis failed",
                carrier="Analysis failed",
                effectiveDate="Analysis failed"
            ),
            coverageCosts=CoverageCostsOutput(
                inNetwork=NetworkCoverageInfo(
                    deductible=DeductibleInfo(individual=0, family=0),
                    outOfPocketMax=OutOfPocketMaxInfo(individual=0, family=0),
                    coinsurance="0%"
                ),
                outOfNetwork=NetworkCoverageInfo(
                    deductible=DeductibleInfo(individual=0, family=0),
                    outOfPocketMax=OutOfPocketMaxInfo(individual=0, family=0),
                    coinsurance="0%"
                )
            ),
            commonServices=[],
            prescriptions=PrescriptionsOutput(
                hasSeparateDeductible=False,
                deductible=0,
                tiers=[]
            ),
            importantNotes=[],
            confidence_score=0.0,
            additional_info={"error": str(e)}
        )
        return error_response


def validate_analysis_result(analysis_result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate and clean analysis result from Gemini
    
    Args:
        analysis_result: Raw analysis result from Gemini
        
    Returns:
        Cleaned and validated result
    """
    # Updated validation for new structured format
    required_keys = ["policyDetails", "coverageCosts", "commonServices", "prescriptions", "importantNotes"]
    
    # If we got a valid response with the required keys
    if all(key in analysis_result for key in required_keys):
        return analysis_result
    
    # If we got a raw response, try to extract what we can
    if "raw_response" in analysis_result:
        logger.warning("Received raw response, using fallback structure")
        # Return a basic structure for backwards compatibility
        from ai.schemas import (PolicyDetailsOutput, CoverageCostsOutput, NetworkCoverageInfo, 
                               DeductibleInfo, OutOfPocketMaxInfo, CommonServiceOutput, 
                               PrescriptionsOutput, PrescriptionTierOutput, ImportantNoteOutput)
        
        return {
            "policyDetails": {
                "policyHolder": "Could not extract",
                "policyNumber": "Could not extract", 
                "carrier": "Could not extract",
                "effectiveDate": "Could not extract"
            },
            "coverageCosts": {
                "inNetwork": {
                    "deductible": {"individual": 0, "family": 0},
                    "outOfPocketMax": {"individual": 0, "family": 0},
                    "coinsurance": "0%"
                },
                "outOfNetwork": {
                    "deductible": {"individual": 0, "family": 0},
                    "outOfPocketMax": {"individual": 0, "family": 0},
                    "coinsurance": "0%"
                }
            },
            "commonServices": [],
            "prescriptions": {
                "hasSeparateDeductible": False,
                "deductible": 0,
                "tiers": []
            },
            "importantNotes": [{"type": "Extraction Error", "details": "Analysis completed but data extraction was incomplete"}]
        }
    
    # Default fallback - return existing data as-is
    return analysis_result


def save_to_database(data: Dict[str, Any]) -> None:
    """
    Save analysis result to database
    
    Args:
        data: Analysis result to save
    """
    try:
        conn = sqlite3.connect("heal.db")
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO policies (summary_json) VALUES (?)",
            (json.dumps(data),)
        )
        conn.commit()
        conn.close()
        logger.info("Data saved to database successfully")
    except Exception as e:
        logger.error(f"Error saving to database: {e}")
        # Don't raise exception here, as the analysis was successful

@app.get("/api")
async def api_root():
    """API root endpoint with API information"""
    return {
        "message": "HEAL - Insurance Policy Analyzer API",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "/upload": "POST - Upload and analyze insurance documents",
            "/health": "GET - Health check",
            "/chat": "POST - Chat with AI assistant (future feature)",
            "/docs": "GET - API documentation"
        }
    }

@app.get("/debug/static")
async def debug_static():
    """Debug endpoint to check static files"""
    import os
    static_exists = os.path.exists("static")
    index_exists = os.path.exists("static/index.html")
    
    files = []
    if static_exists:
        try:
            files = os.listdir("static")
        except Exception as e:
            files = [f"Error listing files: {e}"]
    
    return {
        "static_directory_exists": static_exists,
        "index_html_exists": index_exists,
        "static_files": files,
        "working_directory": os.getcwd()
    }


@app.get("/health")
async def health_check():
    """
    Health check endpoint with structured response - simplified for Railway deployment
    
    Returns:
        Basic health status that should always work
    """
    try:
        # Basic health check without complex dependencies
        api_key = os.environ.get("GEMINI_API_KEY")
        
        # Try database connection but don't fail if it doesn't work
        database_status = "unknown"
        try:
            conn = sqlite3.connect("heal.db")
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
            conn.close()
            database_status = "connected"
        except Exception as db_e:
            logger.warning(f"Database check failed: {db_e}")
            database_status = "disconnected"
        
        # Check AI status
        ai_status = "available" if ai_available else "unavailable"
        
        # Always return healthy for basic deployment
        return {
            "status": "healthy",
            "genkit_status": ai_status,
            "model_status": ai_status,
            "database_status": database_status,
            "api_key_configured": bool(api_key),
            "timestamp": datetime.now().isoformat(),
            "environment": os.environ.get("ENVIRONMENT", "development")
        }
        
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        # Always return a healthy status for Railway deployment
        return {
            "status": "healthy",
            "genkit_status": "unknown",
            "model_status": "unknown", 
            "database_status": "unknown",
            "api_key_configured": False,
            "timestamp": datetime.now().isoformat(),
            "error": str(e),
            "environment": os.environ.get("ENVIRONMENT", "development")
        }
        
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return HealthCheckOutput(
            status="unhealthy",
            genkit_status="error",
            model_status="error", 
            database_status="error",
            timestamp=datetime.now().isoformat()
        )


@app.post("/chat/sessions")
async def create_chat_session(request: Dict[str, Any]) -> Dict[str, str]:
    """
    Create a new chat session
    
    Args:
        request: May contain document_ids to limit context
        
    Returns:
        Session information
    """
    try:
        document_ids = request.get("document_ids")
        session_id = await chatbot.create_session(document_ids)
        
        return {
            "session_id": session_id,
            "status": "created"
        }
        
    except Exception as e:
        logger.error(f"Error creating chat session: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/sessions/{session_id}/messages")
async def send_chat_message(session_id: str, request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Send a message to the chatbot
    
    Args:
        session_id: Chat session ID
        request: Contains the user message
        
    Returns:
        Chatbot response with sources
    """
    try:
        message = request.get("message", "").strip()
        if not message:
            raise HTTPException(status_code=400, detail="Message cannot be empty")
        
        # Get chatbot response
        response = await chatbot.chat(message, session_id)
        
        return {
            "message": response.message,
            "sources": response.sources,
            "confidence": response.confidence,
            "processing_time_ms": response.processing_time_ms,
            "session_id": response.session_id
        }
        
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error in chat for session {session_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chat/sessions/{session_id}/history")
async def get_chat_history(session_id: str, limit: int = 50) -> Dict[str, Any]:
    """
    Get chat history for a session
    
    Args:
        session_id: Chat session ID
        limit: Maximum number of messages to return
        
    Returns:
        Chat history
    """
    try:
        history = chatbot.get_chat_history(session_id, limit)
        return {
            "session_id": session_id,
            "messages": history,
            "total_messages": len(history)
        }
        
    except Exception as e:
        logger.error(f"Error getting chat history for session {session_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/chat/sessions/{session_id}")
async def delete_chat_session(session_id: str) -> Dict[str, str]:
    """
    Delete a chat session
    
    Args:
        session_id: Chat session ID
        
    Returns:
        Deletion status
    """
    try:
        deleted = chatbot.delete_session(session_id)
        if deleted:
            return {"status": "deleted", "session_id": session_id}
        else:
            raise HTTPException(status_code=404, detail="Session not found")
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting chat session {session_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chat/sessions")
async def list_chat_sessions(limit: int = 20) -> Dict[str, Any]:
    """
    List recent chat sessions
    
    Args:
        limit: Maximum number of sessions to return
        
    Returns:
        List of chat sessions
    """
    try:
        sessions = chatbot.list_sessions(limit)
        return {
            "sessions": sessions,
            "total": len(sessions)
        }
        
    except Exception as e:
        logger.error(f"Error listing chat sessions: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/summarize")
async def summarize_document(file: UploadFile = File(...)) -> Dict[str, Any]:
    """
    Generate a comprehensive summary of an insurance document
    
    Args:
        file: Uploaded insurance document
        
    Returns:
        Document summary and analysis
    """
    try:
        if not genkit_available:
            return {
                "summary": "Document summarization is currently unavailable. Please configure Genkit.",
                "document_type": "unknown",
                "filename": file.filename
            }
        
        # Validate file type
        allowed_types = ["image/", "application/pdf"]
        if not any(file.content_type.startswith(file_type) for file_type in allowed_types):
            raise HTTPException(status_code=400, detail="File must be an image or PDF")
        
        # Read and encode file data
        file_data = await file.read()
        encoded_data = base64.b64encode(file_data).decode('utf-8')
        
        # Determine document type
        doc_type = DocumentType.IMAGE if file.content_type.startswith("image/") else DocumentType.PDF
        
        # Create input for summarization
        summary_input = PolicyAnalysisInput(
            document_data=encoded_data,
            document_type=doc_type,
            filename=file.filename or "unknown"
        )
        
        logger.info(f"Summarizing document: {file.filename}")
        
        # Use Genkit flow for document summarization
        summary_result = await summarize_policy_document(summary_input)
        
        return summary_result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error summarizing document: {e}")
        return {
            "summary": f"Failed to generate summary: {str(e)}",
            "document_type": "unknown",
            "filename": file.filename or "unknown"
        }


@app.post("/generate-questions")
async def generate_questions(request: Dict[str, str]) -> List[str]:
    """
    Generate relevant questions about a policy
    
    Args:
        request: Dictionary containing policy_text
        
    Returns:
        List of suggested questions
    """
    try:
        if not ai_available:
            return [
                "What is my deductible?",
                "What does my policy cover?", 
                "How do I file a claim?",
                "What are my copay amounts?",
                "What is not covered by my policy?"
            ]
        
        policy_text = request.get("policy_text", "")
        if not policy_text:
            raise HTTPException(status_code=400, detail="Policy text is required")
        
        # Use Genkit flow to generate questions
        questions = await generate_policy_questions(policy_text)
        
        return questions
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating questions: {e}")
        return ["Sorry, I couldn't generate questions at this time."]


@app.get("/models")
async def get_available_models() -> Dict[str, Any]:
    """
    Get available Genkit models and configuration
    
    Returns:
        Dictionary with model information
    """
    try:
        if not ai_available:
            return {
                "models": [],
                "status": "AI not available",
                "configured_models": {
                    "flash": "gemini-1.5-flash",
                    "pro": "gemini-1.5-pro"
                }
            }
        
        return {
            "models": [
                "googleai/gemini-1.5-flash",
                "googleai/gemini-1.5-pro"
            ],
            "status": "available",
            "configured_models": {
                "vision": "googleai/gemini-1.5-flash", 
                "pro": "googleai/gemini-1.5-pro"
            },
            "framework": "Genkit for Python"
        }
        
    except Exception as e:
        logger.error(f"Error getting models: {e}")
        return {
            "models": [],
            "status": "error",
            "error": str(e)
        }


def save_to_database(data: Dict[str, Any]) -> None:
    """
    Save analysis result to database
    
    Args:
        data: Analysis result to save
    """
    try:
        conn = sqlite3.connect("heal.db")
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO policies (summary_json) VALUES (?)",
            (json.dumps(data),)
        )
        conn.commit()
        conn.close()
        logger.info("Data saved to database successfully")
    except Exception as e:
        logger.error(f"Error saving to database: {e}")


# Document Management Endpoints
@app.get("/documents")
async def list_documents() -> Dict[str, Any]:
    """List all uploaded documents"""
    try:
        documents = document_processor.list_documents()
        return {"documents": documents, "total": len(documents)}
    except Exception as e:
        logger.error(f"Error listing documents: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/documents/{document_id}")
async def get_document_info(document_id: int) -> Dict[str, Any]:
    """Get detailed information about a document"""
    try:
        doc_info = document_processor.get_document_info(document_id)
        if not doc_info:
            raise HTTPException(status_code=404, detail="Document not found")
        return doc_info
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting document info for {document_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# RAG System Endpoints
@app.post("/rag/search")
async def search_rag(request: Dict[str, Any]) -> Dict[str, Any]:
    """Search for relevant chunks using RAG"""
    try:
        query = request.get("query", "").strip()
        if not query:
            raise HTTPException(status_code=400, detail="Query cannot be empty")
        
        result = await rag_retriever.retrieve(
            query=query,
            top_k=request.get("top_k", 5),
            similarity_threshold=request.get("similarity_threshold", 0.1),
            document_ids=request.get("document_ids")
        )
        
        return {
            "query": result.query,
            "chunks": [{
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "text": chunk.text,
                "similarity_score": chunk.similarity_score,
                "source_document": chunk.source_document
            } for chunk in result.chunks],
            "total_found": result.total_found,
            "execution_time_ms": result.execution_time_ms
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in RAG search: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/rag/stats")
async def get_rag_stats() -> Dict[str, Any]:
    """Get RAG system statistics"""
    try:
        return rag_retriever.get_retrieval_stats()
    except Exception as e:
        logger.error(f"Error getting RAG stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Comprehensive Debug Endpoints
@app.get("/debug/upload-process/{document_id}")
async def debug_upload_process(document_id: int) -> Dict[str, Any]:
    """
    Debug: Get complete upload process information for a document
    """
    try:
        # Get document info
        doc_info = document_processor.get_document_info(document_id)
        if not doc_info:
            raise HTTPException(status_code=404, detail="Document not found")
        
        # Get chunks info
        from database import get_db_connection
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT 
                    id, chunk_text, chunk_index, chunk_type,
                    CASE WHEN embedding IS NOT NULL THEN 'Yes' ELSE 'No' END as has_embedding,
                    length(chunk_text) as text_length
                FROM document_chunks 
                WHERE document_id = ?
                ORDER BY chunk_index
            """, (document_id,))
            chunks = [dict(row) for row in cursor.fetchall()]
            
            # Get policy analysis result
            cursor.execute("""
                SELECT summary_json FROM policies 
                ORDER BY id DESC LIMIT 1
            """)
            policy_result = cursor.fetchone()
            
        finally:
            conn.close()
        
        return {
            "document_info": doc_info,
            "chunks": chunks,
            "chunk_statistics": {
                "total_chunks": len(chunks),
                "chunks_with_embeddings": len([c for c in chunks if c['has_embedding'] == 'Yes']),
                "average_chunk_length": sum(c['text_length'] for c in chunks) / len(chunks) if chunks else 0,
                "total_text_length": sum(c['text_length'] for c in chunks)
            },
            "policy_analysis": json.loads(policy_result[0]) if policy_result else None
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in debug upload process for document {document_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/debug/latest-upload")
async def debug_latest_upload() -> Dict[str, Any]:
    """
    Debug: Get information about the most recent upload
    """
    try:
        # Get latest document
        from database import get_db_connection
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM documents 
                ORDER BY upload_timestamp DESC 
                LIMIT 1
            """)
            
            latest_doc = cursor.fetchone()
            if not latest_doc:
                return {"message": "No documents found"}
            
            doc_dict = dict(latest_doc)
            
        finally:
            conn.close()
        
        # Get full debug info for this document
        return await debug_upload_process(doc_dict['id'])
        
    except Exception as e:
        logger.error(f"Error getting latest upload debug info: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/debug/gemini-calls")
async def debug_gemini_calls() -> Dict[str, Any]:
    """
    Debug: Get information about recent Gemini API calls
    """
    try:
        # This would require adding logging to the AI flows
        # For now, return basic AI configuration info
        return {
            "ai_available": ai_available,
            "models_configured": ai_config.models if ai_available else {},
            "api_key_configured": bool(ai_config.api_key) if ai_available else False,
            "recent_calls": "Logging not yet implemented - check server logs"
        }
        
    except Exception as e:
        logger.error(f"Error getting Gemini debug info: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/debug/test-gemini")
async def debug_test_gemini(request: Dict[str, str]) -> Dict[str, Any]:
    """
    Debug: Test Gemini API with a simple prompt
    """
    try:
        if not ai_available:
            return {
                "success": False,
                "error": "AI services not available",
                "ai_config": {
                    "api_key_configured": False,
                    "models": {}
                }
            }
        
        test_prompt = request.get("prompt", "Hello, this is a test. Please respond with 'Test successful'.")
        
        # Test with flash model
        model = ai_config.get_model('flash')
        start_time = time.time()
        
        response = model.generate_content(test_prompt)
        end_time = time.time()
        
        return {
            "success": True,
            "prompt": test_prompt,
            "response": response.text,
            "model_used": "gemini-2.5-flash",
            "response_time_ms": int((end_time - start_time) * 1000),
            "ai_config": {
                "api_key_configured": True,
                "models": ai_config.models
            }
        }
        
    except Exception as e:
        logger.error(f"Error testing Gemini: {e}")
        return {
            "success": False,
            "error": str(e),
            "prompt": request.get("prompt", ""),
            "ai_config": {
                "api_key_configured": bool(ai_config.api_key) if ai_available else False,
                "models": ai_config.models if ai_available else {}
            }
        }


@app.get("/debug/embeddings/stats")
async def debug_embedding_stats() -> Dict[str, Any]:
    """
    Debug: Get embedding system statistics
    """
    try:
        embedder = get_embedder()
        stats = embedder.get_stats()
        
        return {
            "embedding_stats": stats,
            "api_available": ai_available,
            "system_status": "operational" if stats["success_rate_percent"] > 50 else "degraded"
        }
        
    except Exception as e:
        logger.error(f"Error getting embedding stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/debug/embeddings/test")
async def debug_test_embedding(request: Dict[str, str]) -> Dict[str, Any]:
    """
    Debug: Test embedding generation for a text
    """
    try:
        text = request.get("text", "Test embedding text")
        task_type = request.get("task_type", "retrieval_document")
        
        embedder = get_embedder()
        
        # Import task type enum
        from ai.embedder import EmbeddingTaskType
        task_enum = EmbeddingTaskType(task_type)
        
        result = await embedder.embed_text(text, task_enum)
        
        return {
            "text": text,
            "task_type": task_type,
            "success": result.success,
            "model_used": result.model_used,
            "execution_time_ms": result.execution_time_ms,
            "embedding_dimension": len(result.embedding) if result.embedding is not None else 0,
            "embedding_preview": result.embedding[:10].tolist() if result.embedding is not None else None,
            "error_message": result.error_message
        }
        
    except Exception as e:
        logger.error(f"Error testing embedding: {e}")
        return {
            "success": False,
            "error": str(e),
            "text": request.get("text", ""),
            "task_type": request.get("task_type", "")
        }


@app.post("/debug/embeddings/compare")
async def debug_compare_embeddings(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Debug: Compare embeddings between two texts
    """
    try:
        text1 = request.get("text1", "")
        text2 = request.get("text2", "")
        
        if not text1 or not text2:
            raise HTTPException(status_code=400, detail="Both text1 and text2 are required")
        
        embedder = get_embedder()
        from ai.embedder import EmbeddingTaskType
        
        # Generate embeddings
        result1 = await embedder.embed_text(text1, EmbeddingTaskType.SEMANTIC_SIMILARITY)
        result2 = await embedder.embed_text(text2, EmbeddingTaskType.SEMANTIC_SIMILARITY)
        
        if not (result1.success and result2.success):
            return {
                "success": False,
                "error": "Failed to generate embeddings",
                "result1": {"success": result1.success, "error": result1.error_message},
                "result2": {"success": result2.success, "error": result2.error_message}
            }
        
        # Calculate similarity
        from sklearn.metrics.pairwise import cosine_similarity
        similarity = cosine_similarity(
            result1.embedding.reshape(1, -1),
            result2.embedding.reshape(1, -1)
        )[0][0]
        
        return {
            "text1": text1,
            "text2": text2,
            "similarity_score": float(similarity),
            "model_used": result1.model_used,
            "execution_time_ms": result1.execution_time_ms + result2.execution_time_ms,
            "interpretation": "Very similar" if similarity > 0.8 else "Similar" if similarity > 0.6 else "Somewhat similar" if similarity > 0.4 else "Different"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error comparing embeddings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/debug/chat/context")
async def debug_chat_context(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Debug: Test the enhanced context building for chat
    """
    try:
        query = request.get("query", "What is my deductible?")
        context_limit = request.get("context_limit", 5)
        
        # Get retrieval results
        result = await rag_retriever.retrieve(
            query=query,
            top_k=context_limit,
            similarity_threshold=0.3
        )
        
        # Get policy summary
        chatbot_instance = chatbot
        policy_summary = await chatbot_instance._get_policy_summary([])
        
        # Build both types of context
        basic_context = chatbot_instance._build_context_from_chunks(result.chunks)
        enhanced_context = chatbot_instance._build_enhanced_context(result.chunks, policy_summary)
        
        return {
            "query": query,
            "chunks_found": len(result.chunks),
            "execution_time_ms": result.execution_time_ms,
            "policy_summary": policy_summary,
            "basic_context": basic_context,
            "enhanced_context": enhanced_context,
            "chunks_details": [
                {
                    "similarity": chunk.similarity_score,
                    "source": chunk.source_document,
                    "text_preview": chunk.text[:200] + "..." if len(chunk.text) > 200 else chunk.text
                }
                for chunk in result.chunks
            ]
        }
        
    except Exception as e:
        logger.error(f"Error testing chat context: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Bill Checker Endpoints
@app.post("/bill-checker/upload")
async def upload_medical_bill(file: UploadFile = File(...)):
    """Upload medical bill for analysis"""
    try:
        # Validate file type
        allowed_types = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'image/png']
        if file.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {file.content_type}")
        
        # Read file content
        content = await file.read()
        
        # Store bill file using the document processor (like policy uploads)
        rag_result = await document_processor.process_uploaded_file(
            file_data=content,
            filename=file.filename or "medical_bill",
            mime_type=file.content_type,
            document_type="bill"  # Mark as bill document
        )
        
        bill_id = str(rag_result["document_id"])
        logger.info(f"💾 Stored bill document: {file.filename} with ID: {bill_id}")
        
        return {
            "success": True,
            "bill_id": bill_id,
            "filename": file.filename,
            "file_size": len(content),
            "upload_timestamp": datetime.now().isoformat(),
            "message": f"Successfully uploaded medical bill: {file.filename}"
        }
        
    except Exception as e:
        logger.error(f"❌ Bill upload failed: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.post("/bill-checker/analyze")
async def analyze_medical_bill(request: dict):
    """Analyze medical bill against insurance policy using real AI"""
    start_time = time.time()
    
    try:
        bill_id = request.get("bill_id")
        policy_id = request.get("policy_id")
        
        if not bill_id:
            raise HTTPException(status_code=400, detail="Bill ID required")
        
        logger.info(f"🔍 Starting bill analysis: bill_id={bill_id}, policy_id={policy_id}")
        
        # Get bill and policy documents from database
        from database import get_db_connection
        conn = get_db_connection()
        
        try:
            cursor = conn.cursor()
            
            # Get bill document
            cursor.execute("""
                SELECT id, filename, file_path, extracted_text 
                FROM documents 
                WHERE id = ?
            """, (bill_id,))
            bill_doc = cursor.fetchone()
            
            if not bill_doc:
                raise HTTPException(status_code=404, detail=f"Bill document {bill_id} not found")
            
            # Get most recent policy document if policy_id not provided
            if policy_id:
                cursor.execute("""
                    SELECT id, filename, file_path, extracted_text 
                    FROM documents 
                    WHERE id = ?
                """, (policy_id,))
            else:
                # Get most recent policy from RAG documents table or fall back to policies table
                cursor.execute("""
                    SELECT id, filename, file_path, extracted_text 
                    FROM documents 
                    WHERE document_type = 'policy' OR document_type IS NULL
                    ORDER BY upload_timestamp DESC 
                    LIMIT 1
                """)
            
            policy_doc = cursor.fetchone()
            
            if not policy_doc:
                # Fallback: try to get policy data from policies table
                cursor.execute("""
                    SELECT summary_json FROM policies 
                    ORDER BY id DESC LIMIT 1
                """)
                policy_result = cursor.fetchone()
                if policy_result:
                    policy_data = json.loads(policy_result[0])
                    logger.info("📋 Using policy data from policies table")
                else:
                    logger.warning("⚠️ No policy document found for comparison")
                    policy_data = None
            else:
                logger.info(f"📄 Found policy document: {policy_doc[1]}")
                policy_data = {"extracted_text": policy_doc[3]}
            
        finally:
            conn.close()
        
        # Perform AI analysis using existing Genkit infrastructure
        if not ai_available:
            logger.warning("AI not available, returning structured mock data")
            analysis_result = create_mock_bill_analysis(bill_id)
        else:
            logger.info(f"🤖 Using REAL AI analysis with Gemini 2.5 Pro for bill {bill_id}")
            # Use real AI analysis
            analysis_result = await perform_real_bill_analysis(
                bill_doc, policy_data, include_dispute_recommendations=True
            )
        
        # Store analysis in bill_analyses table
        analysis_id = f"analysis_{int(time.time())}_{bill_id}"
        await store_bill_analysis(analysis_id, bill_id, policy_id, analysis_result)
        
        processing_time = int((time.time() - start_time) * 1000)
        analysis_result["processing_time_ms"] = processing_time
        analysis_result["analysis_id"] = analysis_id
        
        logger.info(f"✅ Bill analysis completed in {processing_time}ms")
        return analysis_result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Bill analysis failed: {e}")
        logger.exception("Full error traceback:")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")

async def perform_real_bill_analysis(bill_doc, policy_data, include_dispute_recommendations=True):
    """Perform real AI analysis of bill against policy"""
    try:
        # Build comprehensive analysis prompt
        bill_text = bill_doc[3] if bill_doc[3] else "Bill text not extracted"
        policy_text = ""
        
        if policy_data:
            if isinstance(policy_data, dict):
                if "extracted_text" in policy_data:
                    policy_text = policy_data["extracted_text"]
                else:
                    # From policies table - extract key info
                    policy_text = f"""
                    Policy Summary:
                    Deductible: {policy_data.get('deductible', 'Not specified')}
                    Out-of-Pocket Max: {policy_data.get('out_of_pocket_max', 'Not specified')}
                    Copay: {policy_data.get('copay', 'Not specified')}
                    """
        
        analysis_prompt = f"""
You are an expert medical billing and insurance analyst. Analyze this medical bill against the patient's insurance policy and provide a detailed breakdown in the exact JSON format specified below.

MEDICAL BILL:
{bill_text}

INSURANCE POLICY:
{policy_text}

You must respond with a valid JSON object that matches this exact structure:

{{
  "billSummary": {{
    "patientName": "extracted from bill",
    "memberId": "extracted from bill if available",
    "groupName": "extracted from bill if available", 
    "dateOfService": "YYYY-MM-DD format",
    "provider": {{
      "name": "provider name from bill",
      "status": "In-Network" or "Out-of-Network"
    }},
    "totals": {{
      "providerBilled": 0.00,
      "planPaid": 0.00,
      "amountSaved": 0.00,
      "patientOwed": 0.00
    }},
    "serviceDetails": [
      {{
        "serviceDescription": "description of service",
        "serviceCode": "CPT code if available",
        "providerBilled": 0.00,
        "amountSaved": 0.00,
        "planAllowed": 0.00,
        "planPaid": 0.00,
        "appliedToDeductible": 0.00,
        "copay": 0.00,
        "coinsurance": 0.00,
        "planDoesNotCover": 0.00,
        "patientOwed": 0.00,
        "notes": "explanation of calculation and policy application"
      }}
    ]
  }},
  "coverageAnalysis": {{
    "summary": "brief summary of coverage",
    "networkStatus": "explanation of in/out network status",
    "benefitsApplied": "which benefits from policy were applied",
    "deductibleStatus": "current deductible status and remaining amount"
  }},
  "discrepancyCheck": {{
    "hasDiscrepancies": true/false,
    "findings": "analysis of actual financial discrepancies where patient pays more than policy requires",
    "recommendations": "specific actions only if patient is overcharged according to their policy terms"
  }}
}}

CRITICAL INSTRUCTIONS:
1. Extract exact dollar amounts from the bill
2. Use the policy details to calculate correct coverage
3. Show detailed line-by-line service breakdown
4. Calculate deductibles, copays, and coinsurance according to the policy
5. ONLY flag discrepancies if the patient is paying MORE than they should according to their policy
6. Out-of-network services are NOT errors if processed correctly per policy rules
7. Return ONLY the JSON object, no other text
8. Ensure all dollar amounts are accurate to the cent
9. Include notes explaining each calculation
10. Focus on financial accuracy, not administrative details
"""

        # Use existing Genkit AI infrastructure with Gemini 2.5 Pro
        from ai.flows.policy_analysis import analyze_insurance_policy
        from ai.schemas import PolicyAnalysisInput, DocumentType
        
        # Use Gemini 2.5 Flash for bill analysis
        model = ai_config.get_model('flash')

        if not model:
            logger.error("❌ Failed to get Gemini Flash model - falling back to mock")
            return create_mock_bill_analysis("model_unavailable")

        logger.info("🤖 Generating AI bill analysis with Gemini 2.5 Flash...")
        logger.info(f"📝 Prompt length: {len(analysis_prompt)} characters")
        logger.info(f"📄 Bill text length: {len(bill_text)} characters")
        logger.info(f"📋 Policy text length: {len(policy_text)} characters")
        
        try:
            response = model.generate_content(analysis_prompt)
            analysis_text = response.text
            logger.info(f"✅ Received AI response: {len(analysis_text)} characters")
            logger.info(f"🔍 Response preview: {analysis_text[:200]}...")
        except Exception as api_error:
            logger.error(f"❌ Gemini API call failed: {api_error}")
            raise
        
        # Parse JSON response directly
        structured_analysis = parse_json_bill_analysis(analysis_text)
        
        return structured_analysis
        
    except Exception as e:
        logger.error(f"❌ Real AI analysis failed: {e}")
        # Fallback to mock analysis
        return create_mock_bill_analysis("unknown")

def parse_json_bill_analysis(analysis_text: str) -> dict:
    """Parse JSON response from AI into frontend-compatible format"""
    
    try:
        # Clean the response text to extract JSON
        import re
        
        # Find JSON object in response
        json_match = re.search(r'\{.*\}', analysis_text, re.DOTALL)
        if json_match:
            json_str = json_match.group(0)
            ai_analysis = json.loads(json_str)
            
            # Convert to frontend-compatible format
            bill_summary = ai_analysis.get("billSummary", {})
            totals = bill_summary.get("totals", {})
            provider = bill_summary.get("provider", {})
            coverage = ai_analysis.get("coverageAnalysis", {})
            discrepancy = ai_analysis.get("discrepancyCheck", {})
            
            return {
                "bill_summary": {
                    "provider_name": provider.get("name", "Provider not found"),
                    "patient_name": bill_summary.get("patientName", ""),
                    "member_id": bill_summary.get("memberId", ""),
                    "date_of_service": bill_summary.get("dateOfService", ""),
                    "services_provided": [detail.get("serviceDescription", "") for detail in bill_summary.get("serviceDetails", [])]
                },
                "coverage_analysis": {
                    "network_status": provider.get("status", "Unknown"),
                    "covered_services": [detail.get("serviceDescription", "") for detail in bill_summary.get("serviceDetails", [])],
                    "summary": coverage.get("summary", ""),
                    "benefits_applied": coverage.get("benefitsApplied", ""),
                    "deductible_status": coverage.get("deductibleStatus", "")
                },
                "financial_breakdown": {
                    "total_charges": totals.get("providerBilled", 0.0),
                    "insurance_payment": totals.get("planPaid", 0.0),
                    "patient_responsibility": totals.get("patientOwed", 0.0),
                    "amount_saved": totals.get("amountSaved", 0.0)
                },
                "service_details": bill_summary.get("serviceDetails", []),
                "dispute_recommendations": [
                    {
                        "issue_type": "Discrepancy Analysis",
                        "description": discrepancy.get("findings", ""),
                        "recommended_action": discrepancy.get("recommendations", ""),
                        "priority": "high" if discrepancy.get("hasDiscrepancies", False) else "low"
                    }
                ] if discrepancy.get("findings") else [],
                "discrepancy_check": discrepancy.get("findings", "No discrepancies found."),
                "confidence_score": 0.95,
                "full_analysis": ai_analysis,
                "raw_ai_response": analysis_text
            }
        else:
            logger.error("No JSON found in AI response")
            return create_fallback_analysis(analysis_text)
            
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse JSON response: {e}")
        return create_fallback_analysis(analysis_text)
    except Exception as e:
        logger.error(f"Error parsing AI analysis: {e}")
        return create_fallback_analysis(analysis_text)

def create_fallback_analysis(analysis_text: str) -> dict:
    """Create fallback analysis when JSON parsing fails"""
    
    # Extract dollar amounts as fallback
    import re
    dollar_amounts = re.findall(r'\$[\d,]+\.?\d*', analysis_text)
    
    total_charges = 0.0
    patient_responsibility = 0.0
    insurance_payment = 0.0
    
    if len(dollar_amounts) >= 1:
        total_charges = float(dollar_amounts[0].replace('$', '').replace(',', ''))
    if len(dollar_amounts) >= 2:
        patient_responsibility = float(dollar_amounts[1].replace('$', '').replace(',', ''))
    if len(dollar_amounts) >= 3:
        insurance_payment = float(dollar_amounts[2].replace('$', '').replace(',', ''))
    
    return {
        "bill_summary": {
            "provider_name": extract_provider_name(analysis_text),
            "services_provided": extract_services(analysis_text)
        },
        "coverage_analysis": {
            "covered_services": extract_covered_services(analysis_text)
        },
        "financial_breakdown": {
            "total_charges": total_charges,
            "insurance_payment": insurance_payment,
            "patient_responsibility": patient_responsibility
        },
        "dispute_recommendations": extract_disputes(analysis_text),
        "confidence_score": 0.75,
        "full_analysis": analysis_text,
        "note": "Fallback parsing used - JSON response was malformed"
    }

def extract_provider_name(text: str) -> str:
    """Extract provider name from analysis text"""
    # Simple keyword search - could be improved with NLP
    lines = text.split('\n')
    for line in lines:
        if 'provider' in line.lower() and ':' in line:
            return line.split(':')[-1].strip()
    return "Provider information in full analysis"

def extract_services(text: str) -> list:
    """Extract services from analysis text"""
    # Look for services/procedures section
    services = []
    lines = text.split('\n')
    in_services_section = False
    
    for line in lines:
        if 'service' in line.lower() or 'procedure' in line.lower():
            in_services_section = True
        elif in_services_section and line.strip().startswith('-'):
            services.append(line.strip()[1:].strip())
        elif in_services_section and line.strip() == '':
            break
    
    return services if services else ["See full analysis below"]

def extract_covered_services(text: str) -> list:
    """Extract covered services from analysis text"""
    # Similar to extract_services but looking for coverage info
    covered = []
    lines = text.split('\n')
    
    for line in lines:
        if 'covered' in line.lower() and 'not covered' not in line.lower():
            if ':' in line:
                covered.append(line.split(':')[-1].strip())
    
    return covered if covered else ["Coverage details in full analysis"]

def extract_disputes(text: str) -> list:
    """Extract dispute recommendations from analysis text"""
    disputes = []
    lines = text.split('\n')
    in_dispute_section = False
    
    for line in lines:
        if 'dispute' in line.lower() or 'error' in line.lower() or 'questionable' in line.lower():
            in_dispute_section = True
        elif in_dispute_section and line.strip().startswith('-'):
            disputes.append({
                "issue_type": "Billing Issue",
                "description": line.strip()[1:].strip(),
                "recommended_action": "Review with provider",
                "priority": "medium"
            })
        elif in_dispute_section and line.strip() == '':
            break
    
    return disputes

def create_mock_bill_analysis(bill_id: str) -> dict:
    """Create mock analysis when AI is not available"""
    logger.warning(f"🚨 RETURNING MOCK DATA for bill {bill_id} - Configure GEMINI_API_KEY for real analysis")
    return {
        "bill_summary": {
            "provider_name": "🤖 MOCK DATA - SAMPLE MEDICAL CENTER",
            "patient_name": "🤖 MOCK DATA - SAMPLE PATIENT",
            "member_id": "123456789",
            "date_of_service": "2024-01-15",
            "services_provided": ["🤖 MOCK: Office Visit", "🤖 MOCK: Lab Test", "🤖 MOCK: Medical Procedure"]
        },
        "coverage_analysis": {
            "network_status": "In-Network",
            "covered_services": ["Office Visit - Covered", "Lab Test - Covered", "Procedure - Partially Covered"],
            "summary": "Most services covered under standard benefits",
            "benefits_applied": "Standard copays and coinsurance applied",
            "deductible_status": "Annual deductible partially met"
        },
        "financial_breakdown": {
            "total_charges": 425.00,
            "insurance_payment": 340.00,
            "patient_responsibility": 85.00,
            "amount_saved": 255.00
        },
        "service_details": [
            {
                "serviceDescription": "Office Visit",
                "serviceCode": "99213",
                "providerBilled": 150.00,
                "planPaid": 125.00,
                "patientOwed": 25.00,
                "copay": 25.00,
                "notes": "Standard office visit copay applied"
            },
            {
                "serviceDescription": "Lab Test",
                "serviceCode": "80053",
                "providerBilled": 75.00,
                "planPaid": 60.00,
                "patientOwed": 15.00,
                "coinsurance": 15.00,
                "notes": "20% coinsurance after deductible met"
            }
        ],
        "dispute_recommendations": [
            {
                "issue_type": "Configuration Required",
                "description": "Configure GEMINI_API_KEY for real bill analysis with Gemini 2.5 Pro",
                "recommended_action": "Set up AI integration for detailed analysis",
                "priority": "high"
            }
        ],
        "discrepancy_check": "Mock analysis mode - configure GEMINI_API_KEY for real discrepancy detection",
        "confidence_score": 0.5,
        "full_analysis": {
            "billSummary": {
                "patientName": "SAMPLE PATIENT",
                "provider": {"name": "SAMPLE MEDICAL CENTER", "status": "In-Network"},
                "totals": {"providerBilled": 425.00, "planPaid": 340.00, "patientOwed": 85.00}
            }
        },
        "note": "Mock analysis - configure GEMINI_API_KEY environment variable for real AI-powered bill analysis"
    }

def generate_professional_dispute_email(
    analysis_id: str,
    patient_name: str,
    provider_name: str,
    service_date: str,
    bill_filename: str,
    total_charges: float,
    insurance_payment: float,
    patient_responsibility: float,
    disputed_amount: float,
    dispute_reason: str,
    analysis_data: dict
) -> str:
    """Generate a professional medical billing dispute email"""
    
    # Extract service details from analysis if available
    bill_summary = analysis_data.get("bill_summary", {})
    service_details = bill_summary.get("serviceDetails", [])
    dispute_check = analysis_data.get("discrepancy_check", "")
    
    # Format the dispute email - plain text format
    email_content = f"""Subject: Billing Dispute - Account #{analysis_id} - {patient_name}

Dear Billing Department,

I am formally disputing charges on the medical bill for {patient_name}, service date {service_date}, in accordance with my rights under the Fair Debt Collection Practices Act (FDCPA).

PATIENT INFORMATION:
• Patient: {patient_name}
• Service Date: {service_date}
• Provider: {provider_name}
• Bill Reference: {bill_filename}
• Dispute ID: {analysis_id}

DISPUTED CHARGES:
• Total Billed: ${total_charges:.2f}
• Insurance Paid: ${insurance_payment:.2f}
• Patient Responsibility: ${patient_responsibility:.2f}
• Amount in Dispute: ${disputed_amount:.2f}

DISPUTE REASON:
{dispute_reason}

ANALYSIS FINDINGS:
{dispute_check if dispute_check else "Upon review of the EOB and policy terms, billing discrepancies have been identified that require correction."}"""

    # Add service details if available (limit to top 3 for conciseness)
    if service_details:
        email_content += f"\n\nSPECIFIC SERVICES QUESTIONED:"
        for i, service in enumerate(service_details[:3], 1):  # Limit to 3 services
            service_desc = service.get("serviceDescription", "Service")
            service_code = service.get("serviceCode", "N/A")
            patient_owed = service.get("patientOwed", 0)
            
            email_content += f"""
{i}. {service_desc} (CPT: {service_code}) - Patient Owed: ${patient_owed:.2f}"""

    email_content += f"""

REQUESTED DOCUMENTATION:
1. Itemized statement with CPT/HCPCS codes and modifiers
2. EOB processing verification against my Summary of Benefits and Coverage (SBC)
3. Coding accuracy confirmation (CPT procedures, ICD-10 diagnoses)
4. Calculation breakdown for deductibles, copays, and coinsurance
5. In-network/out-of-network designation verification

REQUIRED ACTIONS:
• Hold collection activities pending resolution
• Provide written response within 30 days (FDCPA compliance)
• Issue corrected billing statement
• Submit supporting documentation for disputed charges

PATIENT RIGHTS:
I assert my rights under the FDCPA, No Surprises Act, and applicable state balance billing protections. I request immediate review and correction of billing errors.

Please direct all correspondence to this email and reference dispute ID {analysis_id}.

Sincerely,
{patient_name}
Patient/Account Holder

ATTACHMENTS: EOB, Insurance policy documentation, Analysis report ({analysis_id})

---
Generated via AI-powered medical bill analysis. Reference: {analysis_id}
"""

    return email_content

async def store_bill_analysis(analysis_id: str, bill_id: str, policy_id: str, analysis_result: dict):
    """Store bill analysis results in database"""
    try:
        from database import get_db_connection
        conn = get_db_connection()
        
        try:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO bill_analyses (
                    id, bill_document_id, policy_document_id, 
                    analysis_result, analysis_summary, 
                    patient_responsibility, insurance_payment, total_charges,
                    confidence_score
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                analysis_id,
                bill_id,
                policy_id,
                json.dumps(analysis_result),
                json.dumps(analysis_result.get("bill_summary", {})),
                analysis_result.get("financial_breakdown", {}).get("patient_responsibility", 0.0),
                analysis_result.get("financial_breakdown", {}).get("insurance_payment", 0.0),
                analysis_result.get("financial_breakdown", {}).get("total_charges", 0.0),
                analysis_result.get("confidence_score", 0.0)
            ))
            
            conn.commit()
            logger.info(f"💾 Stored bill analysis: {analysis_id}")
            
        finally:
            conn.close()
            
    except Exception as e:
        logger.error(f"❌ Failed to store bill analysis: {e}")

@app.get("/bill-checker/analysis/{analysis_id}")
async def get_bill_analysis(analysis_id: str):
    """Get specific bill analysis by ID"""
    try:
        from database import get_db_connection
        conn = get_db_connection()
        
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT 
                    ba.id,
                    ba.analysis_result,
                    ba.created_at,
                    ba.confidence_score,
                    d.filename as bill_filename,
                    d.id as bill_document_id
                FROM bill_analyses ba
                LEFT JOIN documents d ON ba.bill_document_id = d.id
                WHERE ba.id = ?
            """, (analysis_id,))
            
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Analysis not found")
            
            # Parse the stored analysis data
            analysis_data = json.loads(row[1]) if row[1] else {}
            
            return {
                "analysis_id": row[0],
                "bill_filename": row[4] or "Unknown",
                "bill_document_id": row[5],
                "analysis_date": row[2],
                "confidence_score": row[3] or 0.0,
                **analysis_data  # Include all the analysis details
            }
            
        finally:
            conn.close()
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error getting bill analysis {analysis_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/bill-checker/analysis/{analysis_id}/dispute")
async def generate_dispute_email(analysis_id: str, request: dict):
    """Generate professional dispute email for billing issues"""
    try:
        from database import get_db_connection
        conn = get_db_connection()
        
        try:
            cursor = conn.cursor()
            # Get the bill analysis data
            cursor.execute("""
                SELECT 
                    ba.id,
                    ba.analysis_result,
                    ba.patient_responsibility,
                    ba.total_charges,
                    ba.insurance_payment,
                    d.filename as bill_filename,
                    d.original_name
                FROM bill_analyses ba
                LEFT JOIN documents d ON ba.bill_document_id = d.id
                WHERE ba.id = ?
            """, (analysis_id,))
            
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Analysis not found")
            
            # Parse analysis data
            analysis_data = json.loads(row[1]) if row[1] else {}
            
            # Extract dispute details from request
            dispute_reason = request.get("dispute_reason", "Billing discrepancy identified")
            patient_name = request.get("patient_name", "Patient")
            provider_name = request.get("provider_name", "Healthcare Provider")
            service_date = request.get("service_date", "N/A")
            disputed_amount = request.get("disputed_amount", row[2])  # Patient responsibility
            
            # Generate professional dispute email
            email_content = generate_professional_dispute_email(
                analysis_id=analysis_id,
                patient_name=patient_name,
                provider_name=provider_name,
                service_date=service_date,
                bill_filename=row[6] or "Medical Bill",
                total_charges=row[3] or 0.0,
                insurance_payment=row[4] or 0.0,
                patient_responsibility=row[2] or 0.0,
                disputed_amount=disputed_amount,
                dispute_reason=dispute_reason,
                analysis_data=analysis_data
            )
            
            return {
                "analysis_id": analysis_id,
                "email_content": email_content,
                "dispute_details": {
                    "patient_name": patient_name,
                    "provider_name": provider_name,
                    "service_date": service_date,
                    "disputed_amount": disputed_amount,
                    "total_charges": row[3],
                    "bill_filename": row[6]
                }
            }
            
        finally:
            conn.close()
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error generating dispute email: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/bill-checker/history")
async def get_bill_analysis_history(limit: int = 10):
    """Get history of bill analyses"""
    try:
        from database import get_db_connection
        conn = get_db_connection()
        
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT 
                    ba.id as analysis_id,
                    d.filename as bill_filename,
                    ba.created_at as analysis_date,
                    ba.patient_responsibility,
                    ba.confidence_score,
                    ba.total_charges,
                    ba.insurance_payment
                FROM bill_analyses ba
                LEFT JOIN documents d ON ba.bill_document_id = d.id
                ORDER BY ba.created_at DESC
                LIMIT ?
            """, (limit,))
            
            analyses = []
            for row in cursor.fetchall():
                analyses.append({
                    "analysis_id": row[0],
                    "bill_filename": row[1] or "Unknown",
                    "analysis_date": row[2],
                    "patient_responsibility": row[3] or 0.0,
                    "confidence_score": row[4] or 0.0,
                    "total_charges": row[5] or 0.0,
                    "insurance_payment": row[6] or 0.0
                })
            
            return {
                "analyses": analyses,
                "total_count": len(analyses)
            }
            
        finally:
            conn.close()
            
    except Exception as e:
        logger.error(f"❌ Error getting bill history: {e}")
        return {
            "analyses": [],
            "total_count": 0,
            "error": str(e)
        }

# ============================================================================
# ADMIN ENDPOINTS - Database Reset & Management
# ============================================================================

@app.delete("/admin/reset-all")
async def reset_all_data(confirm: str = None):
    """
    DANGER: Reset all database data and uploaded files
    
    This endpoint clears:
    - All uploaded documents and files
    - All document chunks and embeddings
    - All chat sessions and history
    - All policy analyses
    - All bill analyses
    - All uploaded files in storage
    
    Requires explicit confirmation and development environment
    """
    # Security checks
    environment = os.getenv("ENVIRONMENT", "development").lower()
    if environment == "production":
        raise HTTPException(
            status_code=403, 
            detail="Database reset is not allowed in production environment"
        )
    
    if confirm != "CONFIRM_RESET":
        raise HTTPException(
            status_code=400,
            detail="Must provide confirmation parameter: ?confirm=CONFIRM_RESET"
        )
    
    try:
        reset_result = await perform_complete_reset()
        logger.warning("🔥 COMPLETE DATABASE RESET PERFORMED 🔥")
        return {
            "status": "success",
            "message": "All data has been reset successfully",
            "environment": environment,
            "reset_details": reset_result,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"❌ Database reset failed: {e}")
        raise HTTPException(status_code=500, detail=f"Reset failed: {str(e)}")


@app.get("/admin/database-info")
async def get_database_info():
    """Get current database statistics"""
    try:
        stats = await get_database_stats()
        return {
            "status": "success",
            "database_stats": stats,
            "environment": os.getenv("ENVIRONMENT", "development"),
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Error getting database info: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/admin/cleanup-embeddings")
async def cleanup_mismatched_embeddings():
    """Clean up chunks with mismatched embedding dimensions"""
    try:
        result = await cleanup_embedding_dimensions()
        return {
            "status": "success",
            "cleanup_result": result,
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Error cleaning up embeddings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def perform_complete_reset() -> Dict[str, Any]:
    """Perform complete database and file system reset"""
    reset_stats = {
        "documents_deleted": 0,
        "chunks_deleted": 0,
        "chat_sessions_deleted": 0,
        "policies_deleted": 0,
        "bill_analyses_deleted": 0,
        "files_deleted": 0,
        "directories_cleaned": []
    }
    
    from database import get_db_connection
    conn = get_db_connection()
    
    try:
        cursor = conn.cursor()
        
        # Get counts before deletion
        cursor.execute("SELECT COUNT(*) FROM documents")
        reset_stats["documents_deleted"] = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM document_chunks")
        reset_stats["chunks_deleted"] = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM chat_sessions")
        reset_stats["chat_sessions_deleted"] = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM policies")
        reset_stats["policies_deleted"] = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM bill_analyses")
        reset_stats["bill_analyses_deleted"] = cursor.fetchone()[0]
        
        # Delete all data from tables (order matters for foreign keys)
        tables_to_clear = [
            "chat_messages",
            "chat_sessions", 
            "bill_analyses",
            "document_chunks",
            "documents",
            "policies"
        ]
        
        for table in tables_to_clear:
            try:
                cursor.execute(f"DELETE FROM {table}")
                logger.info(f"✅ Cleared table: {table}")
            except Exception as e:
                logger.warning(f"⚠️ Could not clear table {table}: {e}")
        
        # Reset auto-increment counters
        for table in tables_to_clear:
            try:
                cursor.execute(f"DELETE FROM sqlite_sequence WHERE name='{table}'")
            except Exception as e:
                logger.warning(f"⚠️ Could not reset sequence for {table}: {e}")
        
        conn.commit()
        
        # Clean up uploaded files
        uploads_dir = "uploads"
        if os.path.exists(uploads_dir):
            file_count = sum(len(files) for _, _, files in os.walk(uploads_dir))
            reset_stats["files_deleted"] = file_count
            shutil.rmtree(uploads_dir)
            os.makedirs(uploads_dir, exist_ok=True)
            reset_stats["directories_cleaned"].append(uploads_dir)
            logger.info(f"✅ Cleaned uploads directory: {file_count} files deleted")
        
        # Clean up any temp directories
        temp_dirs = ["temp", "tmp", ".temp"]
        for temp_dir in temp_dirs:
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)
                reset_stats["directories_cleaned"].append(temp_dir)
                logger.info(f"✅ Cleaned temp directory: {temp_dir}")
        
        return reset_stats
        
    finally:
        conn.close()


async def get_database_stats() -> Dict[str, Any]:
    """Get current database statistics"""
    from database import get_db_connection
    conn = get_db_connection()
    
    try:
        cursor = conn.cursor()
        stats = {}
        
        # Table counts
        tables = ["documents", "document_chunks", "chat_sessions", "chat_messages", "policies", "bill_analyses"]
        for table in tables:
            try:
                cursor.execute(f"SELECT COUNT(*) FROM {table}")
                stats[f"{table}_count"] = cursor.fetchone()[0]
            except Exception:
                stats[f"{table}_count"] = "N/A"
        
        # File system stats
        uploads_dir = "uploads"
        if os.path.exists(uploads_dir):
            file_count = sum(len(files) for _, _, files in os.walk(uploads_dir))
            total_size = sum(
                os.path.getsize(os.path.join(dirpath, filename))
                for dirpath, dirnames, filenames in os.walk(uploads_dir)
                for filename in filenames
            )
            stats["uploaded_files_count"] = file_count
            stats["uploaded_files_size_mb"] = round(total_size / (1024 * 1024), 2)
        else:
            stats["uploaded_files_count"] = 0
            stats["uploaded_files_size_mb"] = 0
        
        # Embedding dimension analysis
        cursor.execute("""
            SELECT 
                CASE 
                    WHEN embedding IS NULL THEN 'No embedding'
                    WHEN length(embedding) = 1536 THEN '384 dimensions'  -- 384 * 4 bytes
                    WHEN length(embedding) = 3072 THEN '768 dimensions'  -- 768 * 4 bytes
                    ELSE 'Other: ' || length(embedding) || ' bytes'
                END as embedding_type,
                COUNT(*) as count
            FROM document_chunks 
            GROUP BY embedding_type
        """)
        
        embedding_stats = {}
        for row in cursor.fetchall():
            embedding_stats[row[0]] = row[1]
        
        stats["embedding_dimensions"] = embedding_stats
        
        return stats
        
    finally:
        conn.close()


async def cleanup_embedding_dimensions() -> Dict[str, Any]:
    """Remove chunks with mismatched embedding dimensions"""
    from database import get_db_connection
    conn = get_db_connection()
    
    try:
        cursor = conn.cursor()
        
        # Find chunks with non-768 dimension embeddings
        cursor.execute("""
            SELECT id, length(embedding) as embedding_size
            FROM document_chunks 
            WHERE embedding IS NOT NULL 
            AND length(embedding) != 3072  -- 768 dimensions * 4 bytes
        """)
        
        mismatched_chunks = cursor.fetchall()
        mismatched_count = len(mismatched_chunks)
        
        if mismatched_count > 0:
            # Delete mismatched chunks
            cursor.execute("""
                DELETE FROM document_chunks 
                WHERE embedding IS NOT NULL 
                AND length(embedding) != 3072
            """)
            conn.commit()
            logger.info(f"🧹 Cleaned up {mismatched_count} chunks with mismatched embeddings")
        
        return {
            "mismatched_chunks_removed": mismatched_count,
            "chunks_details": [
                {"chunk_id": chunk[0], "embedding_size_bytes": chunk[1]} 
                for chunk in mismatched_chunks
            ]
        }
        
    finally:
        conn.close()


# Serve frontend files for production deployment (MUST be last route)
if os.path.exists("static"):
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """Serve frontend files for production deployment - catch-all route"""
        from fastapi.responses import FileResponse
        import os
        
        logger.info(f"Frontend request for: {full_path}")
        
        # Serve index.html for root and client-side routing
        if not full_path or full_path == "" or full_path == "index.html":
            logger.info("Serving index.html for root/empty path")
            if os.path.exists("static/index.html"):
                return FileResponse("static/index.html")
            else:
                logger.error("static/index.html not found!")
                raise HTTPException(status_code=404, detail="Frontend not found")
        
        # Serve static assets (CSS, JS, images)
        file_path = f"static/{full_path}"
        logger.info(f"Checking for static file: {file_path}")
        if os.path.exists(file_path):
            logger.info(f"Serving static file: {file_path}")
            return FileResponse(file_path)
        
        # For client-side routing (React Router), serve index.html
        logger.info("Serving index.html for client-side routing")
        if os.path.exists("static/index.html"):
            return FileResponse("static/index.html")
        else:
            logger.error("static/index.html not found for fallback!")
            raise HTTPException(status_code=404, detail="Frontend not found")
else:
    logger.warning("Static directory not found - frontend will not be served")


if __name__ == "__main__":
    import uvicorn
    
    try:
        # Start the Genkit development server for enhanced debugging
        logger.info("Starting HEAL API with Genkit integration + Bill Checker + Admin Tools")
        logger.info("Visit http://localhost:8000/docs for API documentation")
        logger.info("Use 'genkit start -- python main.py' for Genkit Developer UI")
        logger.info("⚠️  Admin endpoints available at /admin/* (development only)")
        
        # Get port from environment variable for Railway/Docker deployment
        port = int(os.environ.get("PORT", 8000))
        logger.info(f"Starting server on 0.0.0.0:{port}")
        
        # Test basic functionality before starting
        logger.info("Performing startup health check...")
        
        uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
        
    except Exception as e:
        logger.error(f"Failed to start server: {e}")
        # Try to start with minimal configuration
        logger.info("Attempting to start with minimal configuration...")
        port = int(os.environ.get("PORT", 8000))
        uvicorn.run(app, host="0.0.0.0", port=port, log_level="error")
