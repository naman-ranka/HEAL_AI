// API Service Layer for HEAL.AI Frontend
// Configurable via VITE_API_BASE_URL (see .env.example) so you can point a local
// frontend at a deployed backend without editing source. Falls back to same-origin
// in a production build (Railway serves the SPA + API together) and localhost in dev.
const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (import.meta.env.PROD ? '' : 'http://localhost:8000');

// Types for API responses
export interface PolicyAnalysisResponse {
  policyDetails: {
    policyHolder: string;
    policyNumber: string;
    carrier: string;
    effectiveDate: string;
  };
  coverageCosts: {
    inNetwork: {
      deductible: { individual: number; family: number };
      outOfPocketMax: { individual: number; family: number };
      coinsurance: string;
    };
    outOfNetwork: {
      deductible: { individual: number; family: number };
      outOfPocketMax: { individual: number; family: number };
      coinsurance: string;
    };
  };
  commonServices: Array<{
    service: string;
    cost: string;
    notes: string;
  }>;
  prescriptions: {
    hasSeparateDeductible: boolean;
    deductible: number;
    tiers: Array<{
      tier: string;
      cost: string;
    }>;
  };
  importantNotes: Array<{
    type: string;
    details: string;
  }>;
  confidence_score: number;
  additional_info?: Record<string, any>;
}

export interface ChatResponse {
  message: string;
  sources: Array<{
    document_id: number;
    chunk_id: number;
    text: string;
    similarity_score: number;
  }>;
  confidence: number;
  processing_time_ms: number;
  session_id: string;
}

export interface ChatSessionResponse {
  session_id: string;
  status: string;
}

export interface BillAnalysisResponse {
  bill_summary: {
    provider_name: string;
    patient_name: string;
    member_id: string;
    date_of_service: string;
    services_provided: string[];
  };
  coverage_analysis: {
    network_status: string;
    covered_services: string[];
    summary: string;
    benefits_applied: string;
    deductible_status: string;
  };
  financial_breakdown: {
    total_charges: number;
    insurance_payment: number;
    patient_responsibility: number;
    amount_saved: number;
  };
  service_details: Array<{
    serviceDescription: string;
    serviceCode?: string;
    providerBilled: number;
    planPaid: number;
    patientOwed: number;
    copay?: number;
    coinsurance?: number;
    notes: string;
  }>;
  dispute_recommendations: Array<{
    issue_type: string;
    description: string;
    recommended_action: string;
    priority: string;
  }>;
  discrepancy_check: string;
  confidence_score: number;
  processing_time_ms?: number;
  analysis_id?: string;
}

export interface BillUploadResponse {
  success: boolean;
  bill_id: string;
  filename: string;
  file_size: number;
  upload_timestamp: string;
  message: string;
}

export interface Document {
  id: number;
  filename: string;
  upload_timestamp: string;
  document_type?: string;
  file_size?: number;
}

export interface HealthCheckResponse {
  status: string;
  genkit_status: string;
  model_status: string;
  database_status: string;
  timestamp: string;
}

class ApiService {
  private async fetchWithError(url: string, options?: RequestInit): Promise<Response> {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return response;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  // Health check
  async checkHealth(): Promise<HealthCheckResponse> {
    const response = await this.fetchWithError(`${API_BASE_URL}/health`);
    return response.json();
  }

  // Insurance document upload and analysis
  async uploadInsurance(file: File): Promise<PolicyAnalysisResponse> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE_URL}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${errorText}`);
    }

    return response.json();
  }

  // Bill upload for analysis
  async uploadBill(file: File): Promise<BillUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE_URL}/bill-checker/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bill upload failed: ${errorText}`);
    }

    return response.json();
  }

  // Analyze bill against insurance
  async analyzeBill(billId: string, policyId?: string): Promise<BillAnalysisResponse> {
    const response = await this.fetchWithError(`${API_BASE_URL}/bill-checker/analyze`, {
      method: 'POST',
      body: JSON.stringify({
        bill_id: billId,
        policy_id: policyId,
      }),
    });

    return response.json();
  }

  // Get bill analysis history
  async getBillHistory(limit: number = 10): Promise<{ analyses: Array<any>; total_count: number }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/bill-checker/history?limit=${limit}`);
    return response.json();
  }

  // Get specific bill analysis
  async getBillAnalysis(analysisId: string): Promise<BillAnalysisResponse & { 
    analysis_id: string; 
    bill_filename: string; 
    analysis_date: string; 
  }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/bill-checker/analysis/${analysisId}`);
    return response.json();
  }

  // Generate dispute email
  async generateDisputeEmail(analysisId: string, disputeData: {
    dispute_reason: string;
    patient_name: string;
    provider_name: string;
    service_date: string;
    disputed_amount?: number;
  }): Promise<{
    analysis_id: string;
    email_content: string;
    dispute_details: any;
  }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/bill-checker/analysis/${analysisId}/dispute`, {
      method: 'POST',
      body: JSON.stringify(disputeData),
    });
    return response.json();
  }

  // Chat functionality
  async createChatSession(documentIds?: number[] | null): Promise<ChatSessionResponse> {
    const response = await this.fetchWithError(`${API_BASE_URL}/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        document_ids: documentIds,
      }),
    });

    return response.json();
  }

  async sendChatMessage(sessionId: string, message: string): Promise<ChatResponse> {
    const response = await this.fetchWithError(`${API_BASE_URL}/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message: message,
      }),
    });

    return response.json();
  }

  async getChatHistory(sessionId: string, limit: number = 50): Promise<{ messages: Array<any>; total_messages: number }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/chat/sessions/${sessionId}/history?limit=${limit}`);
    return response.json();
  }

  // Document management
  async getDocuments(): Promise<{ documents: Document[]; total: number }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/documents`);
    return response.json();
  }

  async getDocumentInfo(documentId: number): Promise<Document> {
    const response = await this.fetchWithError(`${API_BASE_URL}/documents/${documentId}`);
    return response.json();
  }

  // RAG search
  async searchDocuments(query: string, topK: number = 5, documentIds?: number[]): Promise<{
    query: string;
    chunks: Array<{
      chunk_id: number;
      document_id: number;
      text: string;
      similarity_score: number;
      source_document: string;
    }>;
    total_found: number;
    execution_time_ms: number;
  }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/rag/search`, {
      method: 'POST',
      body: JSON.stringify({
        query,
        top_k: topK,
        document_ids: documentIds,
      }),
    });

    return response.json();
  }

  // Document summarization
  async summarizeDocument(file: File): Promise<{
    summary: string;
    document_type: string;
    filename: string;
  }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE_URL}/summarize`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Summarization failed: ${errorText}`);
    }

    return response.json();
  }

  // Generate questions about policy
  async generateQuestions(policyText: string): Promise<string[]> {
    const response = await this.fetchWithError(`${API_BASE_URL}/generate-questions`, {
      method: 'POST',
      body: JSON.stringify({
        policy_text: policyText,
      }),
    });

    return response.json();
  }

  // Get available models
  async getAvailableModels(): Promise<{
    models: string[];
    status: string;
    configured_models: Record<string, string>;
  }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/models`);
    return response.json();
  }

  // ============================================================================
  // ADMIN ENDPOINTS - Database Reset & Management
  // ============================================================================

  // Get database statistics
  async getDatabaseStats(): Promise<{
    status: string;
    database_stats: {
      documents_count: number;
      document_chunks_count: number;
      chat_sessions_count: number;
      chat_messages_count: number;
      policies_count: number;
      bill_analyses_count: number;
      uploaded_files_count: number;
      uploaded_files_size_mb: number;
      embedding_dimensions: Record<string, number>;
    };
    environment: string;
    timestamp: string;
  }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/admin/database-info`);
    return response.json();
  }

  // Reset all database data (DANGEROUS)
  async resetAllData(): Promise<{
    status: string;
    message: string;
    environment: string;
    reset_details: {
      documents_deleted: number;
      chunks_deleted: number;
      chat_sessions_deleted: number;
      policies_deleted: number;
      bill_analyses_deleted: number;
      files_deleted: number;
      directories_cleaned: string[];
    };
    timestamp: string;
  }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/admin/reset-all?confirm=CONFIRM_RESET`, {
      method: 'DELETE',
    });
    return response.json();
  }

  // Clean up mismatched embeddings
  async cleanupEmbeddings(): Promise<{
    status: string;
    cleanup_result: {
      mismatched_chunks_removed: number;
      chunks_details: Array<{
        chunk_id: number;
        embedding_size_bytes: number;
      }>;
    };
    timestamp: string;
  }> {
    const response = await this.fetchWithError(`${API_BASE_URL}/admin/cleanup-embeddings`, {
      method: 'POST',
    });
    return response.json();
  }
}

// Export singleton instance
export const apiService = new ApiService();
export default apiService;
