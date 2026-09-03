"""
Genkit-Inspired AI Configuration for HEAL
Provides structured AI flows using google-generativeai with Genkit patterns
"""

import os
import logging
from dotenv import load_dotenv
import google.generativeai as genai
from google.generativeai.types import HarmCategory, HarmBlockThreshold

# Load environment variables
load_dotenv()

logger = logging.getLogger(__name__)

class AIConfig:
    """AI Configuration class with Genkit-inspired patterns"""
    
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.models = {
            # gemini-2.5-flash/-pro were retired for new API keys (404: "no
            # longer available to new users, use models/gemini-3.6-flash").
            'flash': 'gemini-3.6-flash',  # Fast model for images and text
            'pro': 'gemini-3.6-pro',      # Pro model for complex analysis
            'lite': 'gemini-1.5-flash',   # Lightweight — better free tier availability
        }
        
        # Safety settings
        self.safety_settings = {
            HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        }
        
        # Configure Gemini if API key is available
        if self.api_key:
            genai.configure(api_key=self.api_key)
            self.available = True
            logger.info("AI configuration initialized successfully")
        else:
            self.available = False
            logger.warning("GEMINI_API_KEY not found - AI features will use mock responses")
    
    def get_model(self, model_type='flash'):
        """Get configured Gemini model"""
        if not self.available:
            return None
            
        model_name = self.models.get(model_type, self.models['flash'])
        return genai.GenerativeModel(
            model_name=model_name,
            safety_settings=self.safety_settings
        )
    
    def is_available(self):
        """Check if AI services are available"""
        return self.available

# Global AI configuration instance
ai_config = AIConfig()

# Export the configuration
__all__ = ['ai_config']
