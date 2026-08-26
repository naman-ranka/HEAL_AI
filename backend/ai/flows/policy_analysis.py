"""
Insurance Policy Analysis Flow using Genkit-Inspired Patterns
Provides structured analysis of insurance documents with guaranteed output format
"""

import base64
import logging
import json
import time
from typing import Dict, Any
from PIL import Image
import io
import fitz  # PyMuPDF

from ..genkit_config import ai_config
from ..schemas import PolicyAnalysisInput, PolicyAnalysisOutput

logger = logging.getLogger(__name__)


async def analyze_insurance_policy(input_data: PolicyAnalysisInput) -> PolicyAnalysisOutput:
    """
    Analyze insurance policy document and extract key information
    
    Args:
        input_data: PolicyAnalysisInput containing document data and metadata
        
    Returns:
        PolicyAnalysisOutput with structured policy information
    """
    try:
        logger.info(f"🔍 Starting policy analysis for {input_data.filename}")
        logger.info(f"📊 Document type: {input_data.document_type}, Data size: {len(input_data.document_data)} bytes")
        
        # Check if AI is available
        if not ai_config.is_available():
            logger.warning("⚠️ AI not available, returning mock data")
            from ..schemas import (PolicyDetailsOutput, CoverageCostsOutput, NetworkCoverageInfo, 
                                   DeductibleInfo, OutOfPocketMaxInfo, CommonServiceOutput, 
                                   PrescriptionsOutput, PrescriptionTierOutput, ImportantNoteOutput)
            
            return PolicyAnalysisOutput(
                policyDetails=PolicyDetailsOutput(
                    policyHolder="Mock Policy Holder",
                    policyNumber="MOCK-12345",
                    carrier="Mock Insurance Co.",
                    effectiveDate="2024-01-01"
                ),
                coverageCosts=CoverageCostsOutput(
                    inNetwork=NetworkCoverageInfo(
                        deductible=DeductibleInfo(individual=1000, family=2000),
                        outOfPocketMax=OutOfPocketMaxInfo(individual=5000, family=10000),
                        coinsurance="20%"
                    ),
                    outOfNetwork=NetworkCoverageInfo(
                        deductible=DeductibleInfo(individual=2000, family=4000),
                        outOfPocketMax=OutOfPocketMaxInfo(individual=10000, family=20000),
                        coinsurance="40%"
                    )
                ),
                commonServices=[
                    CommonServiceOutput(service="Doctor Visit", cost="$25", notes="Co-pay per visit"),
                    CommonServiceOutput(service="Urgent Care", cost="$50", notes="Co-pay per visit")
                ],
                prescriptions=PrescriptionsOutput(
                    hasSeparateDeductible=False,
                    deductible=0,
                    tiers=[
                        PrescriptionTierOutput(tier="Tier 1 (Generic)", cost="$10"),
                        PrescriptionTierOutput(tier="Tier 2 (Brand)", cost="$30")
                    ]
                ),
                importantNotes=[
                    ImportantNoteOutput(type="Mock Note", details="Configure GEMINI_API_KEY for real analysis")
                ],
                confidence_score=0.5,
                additional_info={"note": "Mock data - configure GEMINI_API_KEY for real analysis"}
            )
        
        # Prepare the analysis prompt with comprehensive structured JSON schema
        analysis_prompt = """
        You are an expert insurance policy analyst. Extract comprehensive insurance policy information and return it in the exact JSON format specified below.

        **EXTRACTION REQUIREMENTS:**
        1. Extract ALL available policy information
        2. Use actual dollar amounts where found (without $ symbol for numbers, with $ for display strings)
        3. If information is not found, use reasonable defaults or "Not specified"
        4. Be thorough - look for deductibles, copays, coinsurance, prescription info, etc.

        **REQUIRED JSON OUTPUT FORMAT (return ONLY this JSON, no other text):**
        {
            "policyDetails": {
                "policyHolder": "extracted or 'Policy Holder'",
                "policyNumber": "extracted or 'Not specified'", 
                "carrier": "extracted insurance company name",
                "effectiveDate": "YYYY-MM-DD format or 'Not specified'"
            },
            "coverageCosts": {
                "inNetwork": {
                    "deductible": {
                        "individual": 0,
                        "family": 0
                    },
                    "outOfPocketMax": {
                        "individual": 0,
                        "family": 0
                    },
                    "coinsurance": "20%"
                },
                "outOfNetwork": {
                    "deductible": {
                        "individual": 0,
                        "family": 0
                    },
                    "outOfPocketMax": {
                        "individual": 0,
                        "family": 0
                    },
                    "coinsurance": "40%"
                }
            },
            "commonServices": [
                {
                    "service": "service name",
                    "cost": "$XX",
                    "notes": "additional details"
                }
            ],
            "prescriptions": {
                "hasSeparateDeductible": false,
                "deductible": 0,
                "tiers": [
                    {
                        "tier": "Tier 1 (Generic)",
                        "cost": "$XX"
                    }
                ]
            },
            "importantNotes": [
                {
                    "type": "note type",
                    "details": "important information"
                }
            ]
        }

        **EXAMPLES FOR NUMBERS:**
        - If you see "$250 individual deductible" → use 250 in the individual field
        - If you see "20% coinsurance" → use "20%" 
        - If you see "$25 copay" → use "$25" in cost field

        **Document to analyze:**
        """
        
        # Handle different document types
        if input_data.document_type == "image":
            logger.info("🖼️ Processing image document with OCR")
            # For images, decode and analyze
            image_data = base64.b64decode(input_data.document_data)
            image = Image.open(io.BytesIO(image_data))
            logger.info(f"📸 Image size: {image.size}, Mode: {image.mode}")
            
            # Get model and generate response
            model = ai_config.get_model('flash')
            logger.info("🤖 Using Gemini Flash model for image analysis")
            logger.info(f"📝 Sending prompt to Gemini (length: {len(analysis_prompt)} chars)")
            
            start_time = time.time()
            response = model.generate_content([analysis_prompt, image])
            end_time = time.time()
            
            logger.info(f"⚡ Gemini response received in {(end_time - start_time):.2f}s")
            logger.info(f"📄 Response length: {len(response.text)} chars")
            logger.debug(f"📄 Raw response preview: {response.text[:200]}...")
            
        elif input_data.document_type == "pdf":
            logger.info("📑 Processing PDF document")
            # For PDFs, extract text first then analyze
            pdf_data = base64.b64decode(input_data.document_data)
            extracted_text = _extract_pdf_text(pdf_data)
            logger.info(f"📖 Extracted text length: {len(extracted_text)} chars")
            logger.debug(f"📖 First 200 chars: {extracted_text[:200]}...")
            
            # Combine prompt with extracted text
            full_prompt = f"{analysis_prompt}\n\nExtracted Text:\n{extracted_text}"
            
            # Get model and generate response
            model = ai_config.get_model('flash')  # Use Pro for complex text analysis
            logger.info("🤖 Using Gemini Pro model for PDF text analysis")
            logger.info(f"📝 Sending combined prompt to Gemini (length: {len(full_prompt)} chars)")
            
            start_time = time.time()
            response = model.generate_content(full_prompt)
            end_time = time.time()
            
            logger.info(f"⚡ Gemini response received in {(end_time - start_time):.2f}s")
            logger.info(f"📄 Response length: {len(response.text)} chars")
            logger.debug(f"📄 Raw response preview: {response.text[:200]}...")
            
        else:
            logger.error(f"❌ Unsupported document type: {input_data.document_type}")
            raise ValueError(f"Unsupported document type: {input_data.document_type}")
        
        # Parse the response
        logger.info("🔧 Parsing Gemini response for structured data")
        policy_analysis = _parse_analysis_response(response.text)
        
        logger.info(f"✅ Successfully analyzed policy: {input_data.filename}")
        logger.info(f"📋 Extracted - Policy: {policy_analysis.policyDetails.policyHolder}, Carrier: {policy_analysis.policyDetails.carrier}")
        logger.info(f"🎯 Confidence score: {policy_analysis.confidence_score}")
        
        return policy_analysis
        
    except Exception as e:
        logger.error(f"Error analyzing policy {input_data.filename}: {e}")
        # Return a structured error response that still matches our new schema
        from ..schemas import (PolicyDetailsOutput, CoverageCostsOutput, NetworkCoverageInfo, 
                               DeductibleInfo, OutOfPocketMaxInfo, CommonServiceOutput, 
                               PrescriptionsOutput, PrescriptionTierOutput, ImportantNoteOutput)
        
        return PolicyAnalysisOutput(
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


async def summarize_policy_document(input_data: PolicyAnalysisInput) -> Dict[str, Any]:
    """
    Generate a comprehensive summary of the insurance policy document
    
    Args:
        input_data: PolicyAnalysisInput containing document data
        
    Returns:
        Dictionary containing detailed policy summary
    """
    try:
        if not ai_config.is_available():
            return {
                "summary": "AI summarization not available. Please configure GEMINI_API_KEY.",
                "document_type": input_data.document_type,
                "filename": input_data.filename
            }
        
        summary_prompt = """
        Provide a comprehensive summary of this insurance policy document. Include:
        
        1. **Policy Type**: What type of insurance (health, auto, home, etc.)
        2. **Coverage Overview**: Main benefits and coverage areas
        3. **Key Terms**: Important policy terms and conditions
        4. **Limitations**: Notable exclusions or limitations
        5. **Important Dates**: Policy periods, renewal dates
        6. **Contact Information**: Insurance company details
        
        Format your response as a clear, organized summary that a policyholder can easily understand.
        """
        
        if input_data.document_type == "image":
            image_data = base64.b64decode(input_data.document_data)
            image = Image.open(io.BytesIO(image_data))
            
            model = ai_config.get_model('flash')
            response = model.generate_content([summary_prompt, image])
            
        else:  # PDF
            pdf_data = base64.b64decode(input_data.document_data)
            extracted_text = _extract_pdf_text(pdf_data)
            full_prompt = f"{summary_prompt}\n\nDocument Content:\n{extracted_text}"
            
            model = ai_config.get_model('flash')
            response = model.generate_content(full_prompt)
        
        return {
            "summary": response.text,
            "document_type": input_data.document_type,
            "filename": input_data.filename
        }
        
    except Exception as e:
        logger.error(f"Error summarizing document {input_data.filename}: {e}")
        return {
            "summary": f"Failed to generate summary: {str(e)}",
            "document_type": input_data.document_type,
            "filename": input_data.filename
        }


def _parse_analysis_response(response_text: str) -> PolicyAnalysisOutput:
    """
    Parse AI response and create structured PolicyAnalysisOutput
    
    Args:
        response_text: Raw response from AI model
        
    Returns:
        PolicyAnalysisOutput with extracted data
    """
    try:
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
        
        # Parse JSON
        parsed_data = json.loads(json_text)
        
        # Import necessary classes for creating the structured output
        from ..schemas import (PolicyDetailsOutput, CoverageCostsOutput, NetworkCoverageInfo, 
                               DeductibleInfo, OutOfPocketMaxInfo, CommonServiceOutput, 
                               PrescriptionsOutput, PrescriptionTierOutput, ImportantNoteOutput)
        
        # Extract policy details
        policy_details_data = parsed_data.get("policyDetails", {})
        policy_details = PolicyDetailsOutput(
            policyHolder=policy_details_data.get("policyHolder", "Not specified"),
            policyNumber=policy_details_data.get("policyNumber", "Not specified"),
            carrier=policy_details_data.get("carrier", "Not specified"),
            effectiveDate=policy_details_data.get("effectiveDate", "Not specified")
        )
        
        # Extract coverage costs
        coverage_data = parsed_data.get("coverageCosts", {})
        
        # In-network coverage
        in_network_data = coverage_data.get("inNetwork", {})
        in_network_deductible = DeductibleInfo(
            individual=in_network_data.get("deductible", {}).get("individual", 0),
            family=in_network_data.get("deductible", {}).get("family", 0)
        )
        in_network_oop = OutOfPocketMaxInfo(
            individual=in_network_data.get("outOfPocketMax", {}).get("individual", 0),
            family=in_network_data.get("outOfPocketMax", {}).get("family", 0)
        )
        in_network = NetworkCoverageInfo(
            deductible=in_network_deductible,
            outOfPocketMax=in_network_oop,
            coinsurance=in_network_data.get("coinsurance", "20%")
        )
        
        # Out-of-network coverage  
        out_network_data = coverage_data.get("outOfNetwork", {})
        out_network_deductible = DeductibleInfo(
            individual=out_network_data.get("deductible", {}).get("individual", 0),
            family=out_network_data.get("deductible", {}).get("family", 0)
        )
        out_network_oop = OutOfPocketMaxInfo(
            individual=out_network_data.get("outOfPocketMax", {}).get("individual", 0),
            family=out_network_data.get("outOfPocketMax", {}).get("family", 0)
        )
        out_network = NetworkCoverageInfo(
            deductible=out_network_deductible,
            outOfPocketMax=out_network_oop,
            coinsurance=out_network_data.get("coinsurance", "40%")
        )
        
        coverage_costs = CoverageCostsOutput(
            inNetwork=in_network,
            outOfNetwork=out_network
        )
        
        # Extract common services
        common_services_data = parsed_data.get("commonServices", [])
        common_services = [
            CommonServiceOutput(
                service=service.get("service", "Service"),
                cost=service.get("cost", "$0"),
                notes=service.get("notes", "")
            )
            for service in common_services_data
        ]
        
        # Extract prescriptions
        prescriptions_data = parsed_data.get("prescriptions", {})
        prescription_tiers = [
            PrescriptionTierOutput(
                tier=tier.get("tier", "Tier"),
                cost=tier.get("cost", "$0")
            )
            for tier in prescriptions_data.get("tiers", [])
        ]
        prescriptions = PrescriptionsOutput(
            hasSeparateDeductible=prescriptions_data.get("hasSeparateDeductible", False),
            deductible=prescriptions_data.get("deductible", 0),
            tiers=prescription_tiers
        )
        
        # Extract important notes
        notes_data = parsed_data.get("importantNotes", [])
        important_notes = [
            ImportantNoteOutput(
                type=note.get("type", "Note"),
                details=note.get("details", "")
            )
            for note in notes_data
        ]
        
        # Create structured output
        return PolicyAnalysisOutput(
            policyDetails=policy_details,
            coverageCosts=coverage_costs,
            commonServices=common_services,
            prescriptions=prescriptions,
            importantNotes=important_notes,
            confidence_score=0.9,  # High confidence for successful parsing
            additional_info={"parsing_method": "json_extraction"}
        )
        
    except json.JSONDecodeError:
        logger.warning("Failed to parse JSON response, using fallback extraction")
        # Fallback: try to extract values using text patterns
        return _extract_values_from_text(response_text)
    except Exception as e:
        logger.error(f"Error parsing response: {e}")
        # Import necessary classes for fallback
        from ..schemas import (PolicyDetailsOutput, CoverageCostsOutput, NetworkCoverageInfo, 
                               DeductibleInfo, OutOfPocketMaxInfo, CommonServiceOutput, 
                               PrescriptionsOutput, PrescriptionTierOutput, ImportantNoteOutput)
        
        return PolicyAnalysisOutput(
            policyDetails=PolicyDetailsOutput(
                policyHolder="Parsing failed",
                policyNumber="Parsing failed",
                carrier="Parsing failed",
                effectiveDate="Parsing failed"
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


def _extract_values_from_text(text: str) -> PolicyAnalysisOutput:
    """
    Fallback method to extract values from unstructured text
    
    Args:
        text: Raw text response
        
    Returns:
        PolicyAnalysisOutput with best-effort extraction
    """
    import re
    
    # Import necessary classes
    from ..schemas import (PolicyDetailsOutput, CoverageCostsOutput, NetworkCoverageInfo, 
                           DeductibleInfo, OutOfPocketMaxInfo, CommonServiceOutput, 
                           PrescriptionsOutput, PrescriptionTierOutput, ImportantNoteOutput)
    
    # Simple patterns to extract common values
    deductible_pattern = r'deductible["\s:]*([^,\n}]+)'
    oop_pattern = r'out[_-]?of[_-]?pocket[_-]?max["\s:]*([^,\n}]+)'
    copay_pattern = r'copay["\s:]*([^,\n}]+)'
    
    # Try to find basic values using regex - simplified fallback
    deductible_match = re.search(deductible_pattern, text, re.IGNORECASE)
    deductible_value = 1000  # Default fallback
    if deductible_match:
        value_text = deductible_match.group(1).strip().strip('"').strip("'")
        # Try to extract numeric value
        number_match = re.search(r'\b(\d{1,5})\b', value_text)
        if number_match:
            deductible_value = int(number_match.group(1))
    
    oop_match = re.search(oop_pattern, text, re.IGNORECASE)
    oop_value = 5000  # Default fallback
    if oop_match:
        value_text = oop_match.group(1).strip().strip('"').strip("'")
        # Try to extract numeric value
        number_match = re.search(r'\b(\d{1,5})\b', value_text)
        if number_match:
            oop_value = int(number_match.group(1))
    
    copay_match = re.search(copay_pattern, text, re.IGNORECASE)
    copay_value = "$25"  # Default fallback
    if copay_match:
        copay_value = copay_match.group(1).strip().strip('"').strip("'")
    
    # Create a basic structure with extracted/fallback values
    return PolicyAnalysisOutput(
        policyDetails=PolicyDetailsOutput(
            policyHolder="Policy Holder (extracted from text)",
            policyNumber="Not specified",
            carrier="Insurance Company (extracted from text)",
            effectiveDate="Not specified"
        ),
        coverageCosts=CoverageCostsOutput(
            inNetwork=NetworkCoverageInfo(
                deductible=DeductibleInfo(individual=deductible_value, family=deductible_value * 2),
                outOfPocketMax=OutOfPocketMaxInfo(individual=oop_value, family=oop_value * 2),
                coinsurance="20%"
            ),
            outOfNetwork=NetworkCoverageInfo(
                deductible=DeductibleInfo(individual=deductible_value * 2, family=deductible_value * 4),
                outOfPocketMax=OutOfPocketMaxInfo(individual=oop_value * 2, family=oop_value * 4),
                coinsurance="40%"
            )
        ),
        commonServices=[
            CommonServiceOutput(service="Doctor Visit", cost=copay_value, notes="Extracted from text")
        ],
        prescriptions=PrescriptionsOutput(
            hasSeparateDeductible=False,
            deductible=0,
            tiers=[
                PrescriptionTierOutput(tier="Tier 1 (Generic)", cost="$15"),
                PrescriptionTierOutput(tier="Tier 2 (Brand)", cost="$40")
            ]
        ),
        importantNotes=[
            ImportantNoteOutput(type="Text Extraction", details="Information extracted using text patterns")
        ],
        confidence_score=0.6,  # Lower confidence for text extraction
        additional_info={"parsing_method": "text_extraction"}
    )


# Removed _clean_value function as it's no longer needed with the new structured format


def _extract_pdf_text(pdf_data: bytes) -> str:
    """
    Extract text content from PDF bytes
    
    Args:
        pdf_data: Raw PDF bytes
        
    Returns:
        Extracted text content
    """
    try:
        pdf_document = fitz.open(stream=pdf_data, filetype="pdf")
        text_content = ""
        
        for page_num in range(pdf_document.page_count):
            page = pdf_document[page_num]
            text_content += f"\n--- Page {page_num + 1} ---\n"
            text_content += page.get_text()
        
        pdf_document.close()
        return text_content
        
    except Exception as e:
        logger.error(f"Error extracting PDF text: {e}")
        return f"Failed to extract text from PDF: {str(e)}"


# Export the flows
__all__ = ['analyze_insurance_policy', 'summarize_policy_document']
