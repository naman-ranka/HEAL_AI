"""
Gemini AI Service
Provides a solid foundation for Gemini AI integration including:
- Document analysis (images and PDFs)
- Chat functionality (for future chatbot)
- Proper error handling and logging
- File management
"""

import os
import json
import base64
import tempfile
import logging
from typing import Optional, Dict, Any, List
from pathlib import Path

import google.generativeai as genai
from google.generativeai.types import HarmCategory, HarmBlockThreshold
import fitz  # PyMuPDF
from PIL import Image
import io

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class GeminiService:
    """
    Gemini AI Service for document analysis and chat functionality
    """
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize Gemini service with API key
        
        Args:
            api_key: Gemini API key. If None, will try to get from environment
        """
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError("Gemini API key not provided. Set GEMINI_API_KEY environment variable.")
        
        # Configure Gemini
        genai.configure(api_key=self.api_key)
        
        # Available models
        self.models = {
            'vision': 'gemini-1.5-flash',  # For image analysis
            'pro': 'gemini-1.5-pro',      # For complex analysis and chat
            'flash': 'gemini-1.5-flash'   # For fast responses
        }
        
        # Safety settings for production use
        self.safety_settings = {
            HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        }
        
        logger.info("Gemini service initialized successfully")
    
    def _get_model(self, model_type: str = 'vision'):
        """Get Gemini model instance"""
        model_name = self.models.get(model_type, self.models['vision'])
        return genai.GenerativeModel(
            model_name=model_name,
            safety_settings=self.safety_settings
        )
    
    async def analyze_image(self, image_data: bytes, prompt: str) -> Dict[str, Any]:
        """
        Analyze an image using Gemini Vision
        
        Args:
            image_data: Raw image bytes
            prompt: Analysis prompt
            
        Returns:
            Dictionary containing analysis results
        """
        try:
            # Convert bytes to PIL Image
            image = Image.open(io.BytesIO(image_data))
            
            # Get vision model
            model = self._get_model('vision')
            
            # Generate content
            response = model.generate_content([prompt, image])
            
            # Parse response
            return self._parse_response(response)
            
        except Exception as e:
            logger.error(f"Error analyzing image: {e}")
            raise Exception(f"Image analysis failed: {str(e)}")
    
    async def analyze_pdf(self, pdf_data: bytes, prompt: str) -> Dict[str, Any]:
        """
        Analyze a PDF document using Gemini
        
        Args:
            pdf_data: Raw PDF bytes
            prompt: Analysis prompt
            
        Returns:
            Dictionary containing analysis results
        """
        try:
            # Create temporary file for PDF
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as temp_file:
                temp_file.write(pdf_data)
                temp_file_path = temp_file.name
            
            try:
                # Upload PDF to Gemini
                uploaded_file = genai.upload_file(temp_file_path)
                
                # Wait for processing
                import time
                while uploaded_file.state.name == "PROCESSING":
                    time.sleep(1)
                    uploaded_file = genai.get_file(uploaded_file.name)
                
                if uploaded_file.state.name == "FAILED":
                    raise Exception("PDF processing failed")
                
                # Get pro model for PDF analysis
                model = self._get_model('flash')
                
                # Generate content
                response = model.generate_content([prompt, uploaded_file])
                
                # Clean up uploaded file
                genai.delete_file(uploaded_file.name)
                
                return self._parse_response(response)
                
            finally:
                # Clean up temporary file
                os.unlink(temp_file_path)
                
        except Exception as e:
            logger.error(f"Error analyzing PDF: {e}")
            raise Exception(f"PDF analysis failed: {str(e)}")
    
    async def extract_pdf_text(self, pdf_data: bytes) -> str:
        """
        Extract text from PDF for fallback processing
        
        Args:
            pdf_data: Raw PDF bytes
            
        Returns:
            Extracted text content
        """
        try:
            # Open PDF with PyMuPDF
            pdf_document = fitz.open(stream=pdf_data, filetype="pdf")
            
            text_content = ""
            for page_num in range(pdf_document.page_count):
                page = pdf_document[page_num]
                text_content += page.get_text()
            
            pdf_document.close()
            return text_content
            
        except Exception as e:
            logger.error(f"Error extracting PDF text: {e}")
            raise Exception(f"PDF text extraction failed: {str(e)}")
    
    async def analyze_text(self, text: str, prompt: str) -> Dict[str, Any]:
        """
        Analyze text content using Gemini
        
        Args:
            text: Text content to analyze
            prompt: Analysis prompt
            
        Returns:
            Dictionary containing analysis results
        """
        try:
            # Get pro model for text analysis
            model = self._get_model('flash')
            
            # Combine prompt and text
            full_prompt = f"{prompt}\n\nDocument content:\n{text}"
            
            # Generate content
            response = model.generate_content(full_prompt)
            
            return self._parse_response(response)
            
        except Exception as e:
            logger.error(f"Error analyzing text: {e}")
            raise Exception(f"Text analysis failed: {str(e)}")
    
    async def chat(self, message: str, chat_history: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """
        Chat functionality for future chatbot implementation
        
        Args:
            message: User message
            chat_history: Previous chat messages
            
        Returns:
            Dictionary containing chat response
        """
        try:
            # Get pro model for chat
            model = self._get_model('flash')
            
            # Start chat session
            chat = model.start_chat(history=chat_history or [])
            
            # Send message
            response = chat.send_message(message)
            
            return {
                "response": response.text,
                "history": chat.history
            }
            
        except Exception as e:
            logger.error(f"Error in chat: {e}")
            raise Exception(f"Chat failed: {str(e)}")
    
    def _parse_response(self, response) -> Dict[str, Any]:
        """
        Parse Gemini response and extract JSON if present
        
        Args:
            response: Gemini response object
            
        Returns:
            Parsed response dictionary
        """
        try:
            response_text = response.text
            
            # Try to extract JSON from response
            if "```json" in response_text:
                json_start = response_text.find("```json") + 7
                json_end = response_text.find("```", json_start)
                json_text = response_text[json_start:json_end].strip()
            elif "```" in response_text:
                json_start = response_text.find("```") + 3
                json_end = response_text.find("```", json_start)
                json_text = response_text[json_start:json_end].strip()
            else:
                json_text = response_text.strip()
            
            # Try to parse as JSON
            try:
                parsed_data = json.loads(json_text)
                return parsed_data
            except json.JSONDecodeError:
                # If not valid JSON, return the text
                return {"raw_response": response_text}
                
        except Exception as e:
            logger.error(f"Error parsing response: {e}")
            return {"error": "Failed to parse response", "raw_response": str(response)}
    
    def get_available_models(self) -> List[str]:
        """Get list of available Gemini models"""
        try:
            models = []
            for model in genai.list_models():
                if 'generateContent' in model.supported_generation_methods:
                    models.append(model.name)
            return models
        except Exception as e:
            logger.error(f"Error getting models: {e}")
            return list(self.models.values())
    
    def health_check(self) -> Dict[str, Any]:
        """
        Perform health check on Gemini service
        
        Returns:
            Health status dictionary
        """
        try:
            # Try to get model list as a simple health check
            models = self.get_available_models()
            return {
                "status": "healthy",
                "available_models": models,
                "configured_models": self.models
            }
        except Exception as e:
            return {
                "status": "unhealthy",
                "error": str(e)
            }
