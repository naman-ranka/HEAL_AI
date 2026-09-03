"""
RAG-powered chatbot for insurance policy questions
"""

import logging
import json
import re
import uuid
import time
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime

from .retriever import RAGRetriever, RetrievedChunk
from database import get_db_connection
from ai.genkit_config import ai_config

logger = logging.getLogger(__name__)

@dataclass
class ChatMessage:
    """Represents a chat message"""
    content: str
    message_type: str  # 'user' or 'assistant'
    timestamp: datetime
    relevant_chunks: Optional[List[int]] = None
    confidence_score: Optional[float] = None

@dataclass
class ChatResponse:
    """Response from the chatbot"""
    message: str
    sources: List[Dict[str, Any]]
    confidence: float
    session_id: str
    processing_time_ms: int
    model_used: str
    tokens_used: Optional[int] = None
    # Groundedness: did the answer stay within the retrieved sources?
    # grounded=False means the post-generation check flagged an unsupported claim.
    grounded: Optional[bool] = None
    groundedness_note: Optional[str] = None

class InsuranceChatbot:
    """RAG-powered chatbot for insurance policy questions"""
    
    def __init__(self):
        self.retriever = RAGRetriever()
    
    async def create_session(self, document_ids: Optional[List[int]] = None) -> str:
        """Create a new chat session"""
        session_id = str(uuid.uuid4())
        
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO chat_sessions (
                    session_id, document_context
                ) VALUES (?, ?)
            """, (
                session_id,
                json.dumps(document_ids) if document_ids else None
            ))
            conn.commit()
            
            logger.info(f"Created chat session {session_id}")
            return session_id
            
        finally:
            conn.close()
    
    async def chat(
        self,
        message: str,
        session_id: str,
        context_limit: int = 5,
        user_context: str = "",
    ) -> ChatResponse:
        """
        Process a chat message and return AI response with RAG context

        Args:
            message: User's message
            session_id: Chat session ID
            context_limit: Number of relevant chunks to retrieve
            user_context: Optional pre-built profile string (insurance, conditions, bill history)

        Returns:
            ChatResponse with AI-generated answer
        """
        start_time = time.time()
        
        try:
            # Get session context (document IDs)
            session_info = self._get_session_info(session_id)
            if not session_info:
                raise ValueError(f"Session {session_id} not found")
            
            document_ids = json.loads(session_info['document_context']) if session_info['document_context'] else None
            
            # Retrieve relevant context using RAG with improved parameters
            retrieval_result = await self.retriever.retrieve(
                query=message,
                top_k=context_limit,
                similarity_threshold=0.3,  # Lower threshold for more permissive matching
                document_ids=document_ids
            )

            # Fail loud on a real retrieval error (e.g. embedding API down) rather
            # than pretending we found no relevant policy info — the two mean very
            # different things to the user.
            if retrieval_result.error:
                processing_time = int((time.time() - start_time) * 1000)
                return ChatResponse(
                    message=(
                        "I couldn't reach the AI service to look through your "
                        "documents just now. Please try again in a moment."
                    ),
                    sources=[],
                    confidence=0.0,
                    session_id=session_id,
                    processing_time_ms=processing_time,
                    model_used='error',
                    grounded=None,
                    groundedness_note=f"retrieval error: {retrieval_result.error}",
                )

            # Get policy summary only when no rich user_context is available
            # (user_context blob already contains insurance name, deductibles, copay etc.)
            policy_summary = "" if user_context else await self._get_policy_summary(document_ids)

            # Build enhanced context from retrieved chunks and policy summary
            context = self._build_enhanced_context(retrieval_result.chunks, policy_summary)
            
            # Get conversation history for context
            conversation_history = self.get_chat_history(session_id, limit=10)
            
            # Generate AI response with conversation context + user profile
            ai_response = await self._generate_ai_response(
                message,
                context,
                retrieval_result.chunks,
                conversation_history,
                user_context=user_context,
            )
            
            # Calculate confidence based on retrieval quality
            confidence = self._calculate_response_confidence(retrieval_result.chunks)

            # Post-generation groundedness check (deterministic, non-LLM)
            grounded, groundedness_note = self._check_groundedness(
                ai_response, retrieval_result.chunks
            )
            if not grounded:
                logger.warning(
                    f"⚠️ Groundedness flag (session {session_id}): {groundedness_note}"
                )

            # Prepare sources information
            sources = self._prepare_sources(retrieval_result.chunks)

            processing_time = int((time.time() - start_time) * 1000)
            
            # Save conversation to database
            chunk_ids = [chunk.chunk_id for chunk in retrieval_result.chunks]
            self._save_chat_message(session_id, message, 'user', None, None)
            self._save_chat_message(
                session_id, 
                ai_response, 
                'assistant', 
                chunk_ids, 
                confidence,
                processing_time
            )
            
            # Update session activity
            self._update_session_activity(session_id)
            
            response = ChatResponse(
                message=ai_response,
                sources=sources,
                confidence=confidence,
                session_id=session_id,
                processing_time_ms=processing_time,
                model_used='gemini-3.6-flash',
                tokens_used=None,  # Would be available in real Genkit implementation
                grounded=grounded,
                groundedness_note=groundedness_note,
            )
            
            logger.info(f"Generated chat response for session {session_id} in {processing_time}ms")
            return response
            
        except Exception as e:
            logger.error(f"Error in chat for session {session_id}: {e}")
            processing_time = int((time.time() - start_time) * 1000)
            
            # Return error response
            return ChatResponse(
                message="I apologize, but I'm having trouble processing your question right now. Please try again.",
                sources=[],
                confidence=0.0,
                session_id=session_id,
                processing_time_ms=processing_time,
                model_used='error'
            )
    
    def _build_context_from_chunks(self, chunks: List[RetrievedChunk]) -> str:
        """Build context string from retrieved chunks"""
        if not chunks:
            return "No relevant policy information found."
        
        context_parts = []
        for i, chunk in enumerate(chunks, 1):
            context_parts.append(f"[Source {i} - {chunk.source_document}]:\n{chunk.text}")
        
        return "\n\n".join(context_parts)
    
    def _build_enhanced_context(self, chunks: List[RetrievedChunk], policy_summary: str) -> str:
        """Build enhanced context with policy summary and retrieved chunks.

        Every source gets a stable citation tag ([S0] for the overview, [S1..N]
        for retrieved sections) so the model can cite the exact source of each
        fact and _prepare_sources can map those tags back to documents.
        """
        context_parts = []

        # Add policy summary first for overall context
        if policy_summary:
            context_parts.append(f"[S0 - Policy overview]:\n{policy_summary}")

        # Add specific relevant chunks, each tagged for citation
        if chunks:
            context_parts.append("RETRIEVED POLICY SECTIONS (cite each fact by its tag):")
            for i, chunk in enumerate(chunks, 1):
                location = f"{chunk.source_document}, section {chunk.chunk_index}"
                context_parts.append(f"[S{i} - {location}]:\n{chunk.text}")
        else:
            context_parts.append("RETRIEVED POLICY SECTIONS:\n(none matched this query)")

        return "\n\n".join(context_parts)
    
    async def _get_policy_summary(self, document_ids: Optional[List[int]] = None) -> str:
        """Get policy summary from the database (scoped to most recent upload)"""
        try:
            conn = get_db_connection()
            try:
                cursor = conn.cursor()
                # policies table has no document_id FK yet; ORDER BY id DESC gives the latest
                cursor.execute("""
                    SELECT summary_json FROM policies
                    ORDER BY id DESC
                    LIMIT 1
                """)
                
                row = cursor.fetchone()
                if not row:
                    return ""
                
                policy_data = json.loads(row[0])
                
                # Build a structured summary
                summary_parts = []
                
                if policy_data.get('deductible'):
                    summary_parts.append(f"Deductible: {policy_data['deductible']}")
                
                if policy_data.get('out_of_pocket_max'):
                    summary_parts.append(f"Out-of-Pocket Maximum: {policy_data['out_of_pocket_max']}")
                
                if policy_data.get('copay'):
                    summary_parts.append(f"Copay Information: {policy_data['copay']}")
                
                if policy_data.get('confidence_score'):
                    summary_parts.append(f"Analysis Confidence: {policy_data['confidence_score']}")
                
                if summary_parts:
                    return "This insurance policy analysis shows:\n" + "\n".join(f"• {part}" for part in summary_parts)
                else:
                    return "Policy analysis data available but no key details extracted."
                    
            finally:
                conn.close()
                
        except Exception as e:
            logger.error(f"Error getting policy summary: {e}")
            return ""
    
    async def _generate_ai_response(
        self,
        user_message: str,
        context: str,
        chunks: List[RetrievedChunk],
        conversation_history: List[Dict[str, Any]] = None,
        user_context: str = "",
    ) -> str:
        """Generate AI response using context"""

        if not ai_config.is_available():
            return self._generate_fallback_response(user_message, chunks, conversation_history)

        try:
            prompt = self._build_conversational_rag_prompt(
                user_message, context, conversation_history, user_context=user_context
            )
            model = ai_config.get_model('flash')
            response = model.generate_content(prompt)
            return response.text

        except Exception as e:
            logger.error(f"Error generating AI response: {e}")
            return self._generate_fallback_response(user_message, chunks, conversation_history)
    
    def _build_rag_prompt(self, user_message: str, context: str) -> str:
        """Build the RAG prompt with enhanced context"""
        return f"""You are HEAL, an expert insurance policy assistant. Your role is to help users understand their insurance policies based on the provided policy information.

FORMATTING REQUIREMENTS:
- Use markdown formatting with **bold** for headers and - for bullet points
- Format lists as bullet points using - character (not •)
- Use clear section headers with **double asterisks**
- Keep responses concise and scannable
- Use **text** for emphasis on important terms
- Each bullet point must be on its own line

RESPONSE GUIDELINES:
1. Use BOTH the policy overview and specific policy sections to provide comprehensive answers
2. Start with information from the policy overview when available, then reference specific sections
3. If information is not in the provided context, clearly state "I don't have that information in your policy documents"
4. Be helpful, clear, and concise
5. Use simple language that policyholders can understand
6. Always be accurate and conservative in your responses
7. When referencing specific amounts or details, mention if they come from the overview vs specific sections
8. If you're uncertain, say so and suggest contacting the insurance company

FORMAT YOUR RESPONSE LIKE THIS:
- [Main answer to the question]
- [Supporting details from policy]

**KEY DETAILS:**
- [Important specific information] 
- [Relevant amounts or conditions]

AVAILABLE POLICY INFORMATION:
{context}

USER QUESTION:
{user_message}

YOUR RESPONSE (use markdown formatting):
"""

    def _build_conversational_rag_prompt(self, user_message: str, context: str, conversation_history: List[Dict[str, Any]] = None, user_context: str = "") -> str:
        """Build a conversational RAG prompt with chat history and user profile context"""

        # Build user context block (insurance name, bill history, conditions, etc.)
        user_context_block = ""
        if user_context:
            user_context_block = f"\nUSER PROFILE (known facts about this user):\n{user_context}\n"

        # Build conversation history string
        history_context = ""
        if conversation_history and len(conversation_history) > 0:
            history_context = "\n**Previous Conversation:**\n"
            for msg in conversation_history[-6:]:  # Last 6 messages for context
                role = "User" if msg['message_type'] == 'user' else "HEAL"
                history_context += f"{role}: {msg['content']}\n"
            history_context += "\n"

        return f"""You are HEAL, an expert insurance policy assistant. You maintain conversational context and help users understand their insurance policies.
You have access to the user's profile (insurance, conditions, bill history) and must use it to personalise every answer.
When the user's insurance name, copay amounts, or bill findings are known, reference them directly instead of giving generic answers.

GROUNDING RULES (critical — this is a financial/medical product, wrong numbers cause real harm):
- Answer ONLY using the AVAILABLE POLICY INFORMATION and USER PROFILE below. Do not use outside knowledge, training data, or assumptions.
- After every specific fact (a dollar amount, percentage, limit, or coverage claim), cite the source tag it came from, e.g. "Your specialist copay is $60 [S2]." Facts from the user profile are cited as [profile].
- If the answer is not in the provided information, say exactly: "I don't have that in your uploaded documents." Then suggest contacting the insurer. NEVER invent or estimate a number.
- Do not cite a tag that does not appear in the provided information.

IMPORTANT FORMATTING RULES:
- Use markdown formatting with **bold** for headers and - for bullet points
- Format lists as bullet points using - character (not •)
- Use clear section headers with **double asterisks**
- Keep responses concise and scannable
- Use **text** for emphasis on important terms
- Each bullet point must be on its own line

RESPONSE GUIDELINES:
1. MAINTAIN CONVERSATION FLOW: Reference previous questions and answers when relevant
2. USE CONVERSATIONAL CONTEXT: Build on what was previously discussed
3. BE CONSISTENT: Don't contradict previous answers unless correcting an error
4. REFER BACK: Use phrases like "As I mentioned earlier..." or "Building on your previous question..."
5. CLARIFY WHEN NEEDED: If the user is asking about something mentioned before, acknowledge it
6. Use BOTH the policy overview and specific policy sections for comprehensive answers
7. If information is not in the provided context, clearly state "I don't have that information in your policy documents"
8. Be helpful, clear, and concise with simple language
9. Always be accurate and conservative in your responses
10. When referencing specific amounts, mention if they come from overview vs specific sections

FORMAT YOUR RESPONSE LIKE THIS EXAMPLE:
- [Main point about the topic]
- [Supporting detail or clarification]
- [Additional relevant information]

**KEY DETAILS:**
- [Important specific information]
- [Relevant amounts or limits]

**WHAT THIS MEANS FOR YOU:**
- [Practical implication]
- [Action you might take]

{user_context_block}{history_context}AVAILABLE POLICY INFORMATION:
{context}

CURRENT USER QUESTION:
{user_message}

YOUR RESPONSE (use plain text with bullet points):
"""
    
    def _generate_fallback_response(self, user_message: str, chunks: List[RetrievedChunk], conversation_history: List[Dict[str, Any]] = None) -> str:
        """Generate a fallback response when AI is not available"""
        if not chunks:
            return """• I don't have enough information in your policy documents to answer that question

• Please contact your insurance company for specific details

NEXT STEPS:
• Call the customer service number on your insurance card

• Reference your policy number when asking questions"""
        
        # Simple keyword-based response
        message_lower = user_message.lower()
        
        if any(word in message_lower for word in ['deductible', 'deduct']):
            return """• I found information about deductibles in your policy documents

• The specific amounts need verification with your insurance company

NEXT STEPS:
• Review the policy details in your documents

• Contact your insurance company for exact deductible amounts"""
        elif any(word in message_lower for word in ['copay', 'co-pay', 'copayment']):
            return """• I found information about copayments in your policy

• Specific copay amounts vary by service type

NEXT STEPS:
• Check the specific policy sections for service details

• Contact your insurance company for exact copay amounts"""
        elif any(word in message_lower for word in ['out of pocket', 'maximum', 'limit']):
            return """• Your policy contains information about out-of-pocket maximums

• These limits protect you from excessive medical costs

NEXT STEPS:
• Review the policy details for specific limit amounts

• Contact your insurance company for current year limits"""
        else:
            return f"""• I found {len(chunks)} relevant sections in your policy documents

• The information needs further clarification for your specific question

NEXT STEPS:
• Review the relevant policy sections

• Contact your insurance company for detailed information"""
    
    def _calculate_response_confidence(self, chunks: List[RetrievedChunk]) -> float:
        """Calculate confidence score based on retrieval quality"""
        if not chunks:
            return 0.0
        
        # Average similarity score of top chunks
        avg_similarity = sum(chunk.similarity_score for chunk in chunks) / len(chunks)
        
        # Boost confidence if we have multiple relevant chunks
        chunk_bonus = min(len(chunks) * 0.1, 0.3)
        
        confidence = min(avg_similarity + chunk_bonus, 1.0)
        return round(confidence, 2)
    
    def _prepare_sources(self, chunks: List[RetrievedChunk]) -> List[Dict[str, Any]]:
        """Prepare source information for response.

        The ``label`` (S1, S2, ...) matches the citation tags injected into the
        prompt by _build_enhanced_context, so the frontend can turn an inline
        [S1] in the answer into a link to this source.
        """
        sources = []
        for i, chunk in enumerate(chunks, 1):
            # Fix undefined document names and NaN similarities
            document_name = chunk.source_document if chunk.source_document and chunk.source_document != "undefined" else "Policy Document"
            similarity = chunk.similarity_score if chunk.similarity_score and not str(chunk.similarity_score).lower() == 'nan' else 0.0

            sources.append({
                "label": f"S{i}",
                "document": document_name,
                "section": chunk.chunk_index,
                "similarity": round(similarity, 3),
                "preview": chunk.text[:150] + "..." if len(chunk.text) > 150 else chunk.text,
                "chunk_id": chunk.chunk_id
            })
        return sources

    def _check_groundedness(
        self, answer: str, chunks: List[RetrievedChunk]
    ) -> Tuple[bool, str]:
        """Deterministic post-generation groundedness check.

        Cheap and non-LLM (so it can't itself hallucinate and doesn't add cost
        or latency to the hot path). It catches the failure mode that matters
        most for a money product: stating a specific figure with no supporting
        source. Returns (grounded, note).
        """
        text = answer or ""
        lower = text.lower()

        # The model explicitly declined to answer beyond the context — that's grounded.
        if "don't have that" in lower or "do not have that" in lower:
            return True, "Model declined to answer beyond the provided context."

        has_citation = bool(re.search(r"\[S\d+\]|\[profile\]", text))
        # A "specific claim" = a dollar amount or a percentage.
        has_specific_claim = bool(re.search(r"\$\s?\d|\b\d+(\.\d+)?\s?%", text))

        if has_specific_claim and not chunks:
            return False, "States specific figures but no sources were retrieved."
        if has_specific_claim and not has_citation:
            return False, "States specific figures without citing a source."
        if has_citation:
            return True, "Specific claims cite retrieved sources."
        return True, "No specific figures to verify."
    
    def _get_session_info(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get session information from database"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM chat_sessions WHERE session_id = ?
            """, (session_id,))
            
            row = cursor.fetchone()
            return dict(row) if row else None
            
        finally:
            conn.close()
    
    def _save_chat_message(
        self, 
        session_id: str, 
        content: str, 
        message_type: str,
        relevant_chunks: Optional[List[int]] = None,
        confidence_score: Optional[float] = None,
        processing_time_ms: Optional[int] = None
    ):
        """Save chat message to database"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO chat_messages (
                    session_id, message_type, content, relevant_chunks,
                    confidence_score, model_used, processing_time_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id,
                message_type,
                content,
                json.dumps(relevant_chunks) if relevant_chunks else None,
                confidence_score,
                'gemini-3.6-flash' if message_type == 'assistant' else None,
                processing_time_ms
            ))
            conn.commit()
            
        finally:
            conn.close()
    
    def _update_session_activity(self, session_id: str):
        """Update session last activity timestamp"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE chat_sessions 
                SET last_activity = CURRENT_TIMESTAMP 
                WHERE session_id = ?
            """, (session_id,))
            conn.commit()
            
        finally:
            conn.close()
    
    def get_chat_history(self, session_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Get chat history for a session"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM chat_messages 
                WHERE session_id = ? 
                ORDER BY created_at ASC 
                LIMIT ?
            """, (session_id, limit))
            
            messages = []
            for row in cursor.fetchall():
                message = dict(row)
                # Parse relevant_chunks JSON
                if message['relevant_chunks']:
                    message['relevant_chunks'] = json.loads(message['relevant_chunks'])
                messages.append(message)
            
            return messages
            
        finally:
            conn.close()
    
    def delete_session(self, session_id: str) -> bool:
        """Delete a chat session and its messages"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            
            # Delete messages first (foreign key constraint)
            cursor.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
            
            # Delete session
            cursor.execute("DELETE FROM chat_sessions WHERE session_id = ?", (session_id,))
            
            deleted = cursor.rowcount > 0
            conn.commit()
            
            if deleted:
                logger.info(f"Deleted chat session {session_id}")
            
            return deleted
            
        finally:
            conn.close()
    
    def list_sessions(self, limit: int = 20) -> List[Dict[str, Any]]:
        """List recent chat sessions"""
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT 
                    cs.*,
                    COUNT(cm.id) as message_count
                FROM chat_sessions cs
                LEFT JOIN chat_messages cm ON cs.session_id = cm.session_id
                GROUP BY cs.session_id
                ORDER BY cs.last_activity DESC
                LIMIT ?
            """, (limit,))
            
            return [dict(row) for row in cursor.fetchall()]
            
        finally:
            conn.close()
