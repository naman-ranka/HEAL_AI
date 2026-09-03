import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import ReactMarkdown from 'react-markdown';
import { 
  DollarSign,
  FileText,
  AlertTriangle,
  CheckCircle,
  Download,
  Flag,
  Building2,
  User,
  Calendar,
  Hash
} from "lucide-react";

interface BillAnalysisData {
  bill_filename: string;
  analysis_date: string;
  confidence_score: number;
  financial_breakdown?: {
    total_charges: number;
    patient_responsibility: number;
    insurance_payment: number;
    amount_saved?: number;
  };
  bill_summary?: {
    patient_name?: string;
    member_id?: string;
    date_of_service?: string;
    provider_name?: string;
    provider?: {
      name: string;
      status: string;
    };
  };
  coverage_analysis?: {
    summary: string;
    network_status: string;
    benefits_applied: string;
    deductible_status: string;
  };
  service_details?: Array<{
    serviceDescription: string;
    serviceCode?: string;
    providerBilled: number;
    planPaid: number;
    patientOwed: number;
    copay?: number;
    coinsurance?: number;
    notes: string;
  }>;
  discrepancy_check?: {
    has_discrepancies?: boolean;
    findings?: string;
    recommendations?: string;
  } | string;
  dispute_recommendations?: Array<{
    issue_type: string;
    description: string;
    recommended_action: string;
    priority: string;
  }> | string[];
  processing_time_ms?: number;
}

interface BillSummaryCardProps {
  data: BillAnalysisData;
  onFileDispute?: () => void;
}

const BillSummaryCard: React.FC<BillSummaryCardProps> = ({ data, onFileDispute }) => {
  // Handle different discrepancy check formats
  const discrepancyCheck = typeof data.discrepancy_check === 'string' 
    ? { findings: data.discrepancy_check, has_discrepancies: false }
    : data.discrepancy_check;

  const hasDiscrepancies = discrepancyCheck?.has_discrepancies || 
                          (Array.isArray(data.dispute_recommendations) && data.dispute_recommendations.length > 0);

  // Use only real service_details data from backend
  const serviceBreakdown = data.service_details?.map((service, index) => ({
    id: index + 1,
    title: service.serviceDescription,
    code: service.serviceCode ? `CPT: ${service.serviceCode}` : "",
    amount: service.patientOwed ?? 0,
    explanation: service.notes,
    breakdown: [
      ...(service.copay && service.copay > 0 ? [{ label: "Copay", amount: service.copay, description: "Fixed copay amount per your plan benefits." }] : []),
      ...(service.coinsurance && service.coinsurance > 0 ? [{ label: "Coinsurance", amount: service.coinsurance, description: "Your coinsurance responsibility after deductible." }] : []),
      ...(service.providerBilled && service.planPaid ? [{ label: "Plan Paid", amount: service.planPaid, description: `Insurance paid $${service.planPaid.toFixed(2)} of $${service.providerBilled.toFixed(2)} billed.` }] : []),
    ].filter(item => item.amount > 0)
  })) || [];

  const discrepancyText = hasDiscrepancies 
    ? discrepancyCheck?.findings || "Potential billing discrepancies identified requiring review."
    : discrepancyCheck?.findings || "All charges have been processed correctly according to your insurance policy terms.";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Professional Header */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Bill Analysis Summary</h1>
            <div className="flex items-center text-gray-600 space-x-3">
              <span className="text-sm">{data.bill_filename}</span>
              <span>•</span>
              <span className="text-sm">{new Date(data.analysis_date).toLocaleDateString()}</span>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              {(data.confidence_score * 100).toFixed(0)}% confidence
            </Badge>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-2" />
              Download
            </Button>
          </div>
        </div>
      </div>

      {/* Financial Overview */}
      <Card className="border-gray-200">
        <CardHeader className="bg-gray-50 pb-3">
          <CardTitle className="flex items-center text-gray-900">
            <DollarSign className="h-5 w-5 mr-2 text-gray-600" />
            Financial Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-4">
          <div className={`grid gap-8 ${data.financial_breakdown?.amount_saved ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <div className="text-center">
              <div className="text-3xl font-bold text-gray-900 mb-1">
                ${data.financial_breakdown?.total_charges?.toFixed(2) || '0.00'}
              </div>
              <div className="text-sm text-gray-600">Total amount billed by the provider</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-red-600 mb-1">
                ${data.financial_breakdown?.patient_responsibility?.toFixed(2) || '0.00'}
              </div>
              <div className="text-sm text-gray-600">What you are paying</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-blue-600 mb-1">
                ${data.financial_breakdown?.insurance_payment?.toFixed(2) || '0.00'}
              </div>
              <div className="text-sm text-gray-600">What the insurance is paying</div>
            </div>
            {data.financial_breakdown?.amount_saved && data.financial_breakdown.amount_saved > 0 && (
              <div className="text-center">
                <div className="text-3xl font-bold text-green-600 mb-1">
                  ${data.financial_breakdown.amount_saved.toFixed(2)}
                </div>
                <div className="text-sm text-gray-600">Amount you saved</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Professional Explanation */}
      <Card className="border-gray-200">
        <CardHeader className="bg-gray-50 pb-3">
          <CardTitle className="text-gray-900">Coverage Analysis</CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-4">
          <div className="prose prose-gray max-w-none text-gray-700 leading-relaxed">
            <ReactMarkdown
              components={{
                p: ({ node, ...props }) => <p className="mb-3" {...props} />,
                strong: ({ node, ...props }) => <strong className="font-semibold text-gray-900" {...props} />,
                ul: ({ node, ...props }) => <ul className="list-disc list-inside space-y-1 ml-4" {...props} />,
                li: ({ node, ...props }) => <li className="text-gray-700" {...props} />,
              }}
            >
              {data.coverage_analysis?.summary || "Coverage analysis will be displayed when available from the backend."}
            </ReactMarkdown>
          </div>
        </CardContent>
      </Card>

      {/* Visual Service Breakdown - Only show if we have real data */}
      {serviceBreakdown.length > 0 && (
        <Card className="border-gray-200">
          <CardHeader className="bg-gray-50 pb-3">
            <CardTitle className="text-gray-900">Service Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="p-6 pt-4">
            <div className="space-y-4">
              {serviceBreakdown.map((service) => (
              <div key={service.id} className="border border-gray-200 rounded-lg p-4 bg-white">
                {/* Service Header */}
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {service.id}. {service.title}
                    </h3>
                    {service.code && (
                      <p className="text-sm text-gray-600 mt-1">{service.code}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-red-600">
                      You Owe: ${service.amount?.toFixed(2) || '0.00'}
                    </div>
                  </div>
                </div>

                {/* Service Breakdown Details */}
                {service.breakdown && (
                  <div className="bg-gray-50 rounded-lg p-3 mb-3">
                    <h4 className="font-medium text-gray-900 mb-2">Breakdown:</h4>
                    <div className="space-y-2">
                      {service.breakdown.map((item, index) => (
                        <div key={index} className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex items-center justify-between">
                              <span className="font-medium text-gray-800">{item.label}:</span>
                              <span className="font-semibold text-gray-900">${item.amount?.toFixed(2) || '0.00'}</span>
                            </div>
                            <p className="text-sm text-gray-600 mt-1">{item.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Service Explanation */}
                <div className="bg-blue-50 rounded-lg p-3">
                  <h4 className="font-medium text-blue-900 mb-1">Explanation:</h4>
                  <p className="text-sm text-blue-800">{service.explanation}</p>
                </div>
              </div>
            ))}

            {/* Total Summary */}
            <div className="mt-6 p-4 bg-gradient-to-r from-gray-50 to-gray-100 rounded-lg border border-gray-200">
              <div className="flex justify-between items-center">
                <span className="text-lg font-semibold text-gray-900">Total Patient Responsibility:</span>
                <span className="text-2xl font-bold text-red-600">
                  ${data.financial_breakdown?.patient_responsibility?.toFixed(2) || '0.00'}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
        </Card>
      )}

      {/* Review Status */}
      <Card className={`border-gray-200 ${hasDiscrepancies ? 'bg-amber-50' : 'bg-green-50'}`}>
        <CardHeader className="pb-3">
          <CardTitle className={`flex items-center ${hasDiscrepancies ? 'text-amber-800' : 'text-green-800'}`}>
            {hasDiscrepancies ? 
              <AlertTriangle className="h-5 w-5 mr-2" /> : 
              <CheckCircle className="h-5 w-5 mr-2" />
            }
            Review Status
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <p className={`mb-4 ${hasDiscrepancies ? 'text-amber-700' : 'text-green-700'}`}>
            {discrepancyText}
          </p>
          <Button 
            onClick={onFileDispute}
            variant={hasDiscrepancies ? "default" : "outline"}
            className="w-full"
          >
            <Flag className="h-4 w-4 mr-2" />
            File Dispute
          </Button>
        </CardContent>
      </Card>

      {/* Bottom Section with Bill Info and Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bill Information */}
        <Card className="border-gray-200">
          <CardHeader className="bg-gray-50 pb-3">
            <CardTitle className="flex items-center text-gray-900">
              <FileText className="h-5 w-5 mr-2 text-gray-600" />
              Bill Information
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 pt-4">
            <div className="space-y-3">
              <div className="flex items-center">
                <Building2 className="h-4 w-4 text-gray-500 mr-3" />
                  <div>
                    <div className="text-sm text-gray-600">Provider</div>
                    <div className="font-medium">
                      {data.bill_summary?.provider?.name || data.bill_summary?.provider_name || 'Not specified'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center">
                  <User className="h-4 w-4 text-gray-500 mr-3" />
                  <div>
                    <div className="text-sm text-gray-600">Patient</div>
                    <div className="font-medium">{data.bill_summary?.patient_name || 'Not specified'}</div>
                  </div>
                </div>
                <div className="flex items-center">
                  <Calendar className="h-4 w-4 text-gray-500 mr-3" />
                  <div>
                    <div className="text-sm text-gray-600">Service Date</div>
                    <div className="font-medium">{data.bill_summary?.date_of_service || 'Not specified'}</div>
                  </div>
                </div>
                <div className="flex items-center">
                  <Hash className="h-4 w-4 text-gray-500 mr-3" />
                  <div>
                    <div className="text-sm text-gray-600">Member ID</div>
                    <div className="font-medium">{data.bill_summary?.member_id || 'Not specified'}</div>
                  </div>
                </div>
              {data.processing_time_ms && (
                <div className="flex items-center">
                  <Calendar className="h-4 w-4 text-gray-500 mr-3" />
                  <div>
                    <div className="text-sm text-gray-600">Processing Time</div>
                    <div className="font-medium">{(data.processing_time_ms / 1000).toFixed(1)}s</div>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <Card className="border-gray-200">
          <CardHeader className="bg-gray-50 pb-3">
            <CardTitle className="text-gray-900">Actions</CardTitle>
          </CardHeader>
          <CardContent className="p-6 pt-4">
            <div className="space-y-3">
              <Button variant="outline" className="w-full justify-start">
                <Download className="h-4 w-4 mr-2" />
                Download Report
              </Button>
              <Button variant="outline" className="w-full justify-start">
                <FileText className="h-4 w-4 mr-2" />
                View Original Bill
              </Button>
              <Button 
                variant="outline" 
                className="w-full justify-start"
                onClick={onFileDispute}
              >
                <Flag className="h-4 w-4 mr-2" />
                File Dispute
              </Button>
            </div>
            <Separator className="my-4" />
            <div className="text-xs text-gray-500 space-y-1">
              <div>Analysis Date: {new Date(data.analysis_date).toLocaleDateString()}</div>
              <div>Analysis ID: analysis_{Date.now()}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default BillSummaryCard;