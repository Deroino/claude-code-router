import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, X, Copy, Download, Filter } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface BatchTestResult {
  provider: string;
  model: string;
  status: "success" | "error" | "pending" | "testing";
  message?: string;
  response?: string;
  timestamp?: number;
}

interface BatchTestDialogProps {
  open: boolean;
  onClose: () => void;
  results: BatchTestResult[];
  title?: string;
}

export function BatchTestDialog({
  open,
  onClose,
  results,
  title = "Batch Test Results"
}: BatchTestDialogProps) {
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error" | "testing">("all");

  const filteredResults = results.filter(r => {
    if (statusFilter === "all") return true;
    if (statusFilter === "testing") return r.status === "testing" || r.status === "pending";
    return r.status === statusFilter;
  });

  const successCount = results.filter(r => r.status === "success").length;
  const errorCount = results.filter(r => r.status === "error").length;
  const testingCount = results.filter(r => r.status === "testing" || r.status === "pending").length;

  const handleCopyResults = () => {
    const text = filteredResults.map(r => {
      const statusIcon = r.status === "success" ? "✓" : r.status === "error" ? "✗" : r.status === "testing" ? "⟳" : "?";
      const message = r.message ? ` - ${r.message}` : "";
      const response = r.response ? `\n  Response: ${r.response}` : "";
      return `${statusIcon} ${r.provider}/${r.model}${message}${response}`;
    }).join("\n");
    navigator.clipboard.writeText(text);
  };

  const handleDownloadResults = () => {
    const data = filteredResults.map(r => ({
      provider: r.provider,
      model: r.model,
      status: r.status,
      message: r.message || "",
      response: r.response || "",
      timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : ""
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `batch-test-results-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isRunning = testingCount > 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] flex flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{title}</span>
            {isRunning && (
              <span className="text-sm font-normal text-gray-500 animate-pulse">
                Testing... ({testingCount} remaining)
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Summary */}
        <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-md border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Total:</span>
            <Badge variant="outline">{results.length}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-500" />
            <span className="text-sm font-medium">Success:</span>
            <Badge variant="outline" className="text-emerald-600 border-emerald-200">
              {successCount}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <X className="h-4 w-4 text-rose-500" />
            <span className="text-sm font-medium">Failed:</span>
            <Badge variant="outline" className="text-rose-600 border-rose-200">
              {errorCount}
            </Badge>
          </div>
          {isRunning && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Testing:</span>
              <Badge variant="outline" className="text-amber-600 border-amber-200">
                {testingCount}
              </Badge>
            </div>
          )}
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-500" />
          <div className="flex gap-2">
            <Button
              variant={statusFilter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter("all")}
            >
              All ({results.length})
            </Button>
            <Button
              variant={statusFilter === "success" ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter("success")}
            >
              <Check className="h-3 w-3 mr-1" />
              Success ({successCount})
            </Button>
            <Button
              variant={statusFilter === "error" ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter("error")}
            >
              <X className="h-3 w-3 mr-1" />
              Failed ({errorCount})
            </Button>
            {isRunning && (
              <Button
                variant={statusFilter === "testing" ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter("testing")}
              >
                Testing ({testingCount})
              </Button>
            )}
          </div>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyResults}
            >
              <Copy className="h-4 w-4 mr-1" />
              Copy
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadResults}
            >
              <Download className="h-4 w-4 mr-1" />
              Export
            </Button>
          </div>
        </div>

        {/* Results Table */}
        <div className="flex-grow overflow-y-auto border rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="text-left p-3 font-medium border-b">Provider</th>
                <th className="text-left p-3 font-medium border-b">Model</th>
                <th className="text-left p-3 font-medium border-b">Status</th>
                <th className="text-left p-3 font-medium border-b">Details</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center p-8 text-gray-500">
                    No results to display
                  </td>
                </tr>
              ) : (
                filteredResults.map((result, index) => (
                  <tr key={`${result.provider}-${result.model}-${index}`} className="border-b hover:bg-gray-50">
                    <td className="p-3 font-medium">{result.provider}</td>
                    <td className="p-3 font-mono text-xs">{result.model}</td>
                    <td className="p-3">
                      {result.status === "success" && (
                        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">
                          <Check className="h-3 w-3 mr-1" />
                          Success
                        </Badge>
                      )}
                      {result.status === "error" && (
                        <Badge className="bg-rose-100 text-rose-700 border-rose-200">
                          <X className="h-3 w-3 mr-1" />
                          Failed
                        </Badge>
                      )}
                      {result.status === "testing" && (
                        <Badge className="bg-amber-100 text-amber-700 border-amber-200 animate-pulse">
                          Testing...
                        </Badge>
                      )}
                      {result.status === "pending" && (
                        <Badge variant="outline">
                          Pending
                        </Badge>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="space-y-1">
                        {result.message && (
                          <div className="text-xs text-gray-600">{result.message}</div>
                        )}
                        {result.response && (
                          <div className="text-xs text-gray-500 max-w-md truncate" title={result.response}>
                            {result.response}
                          </div>
                        )}
                        {result.timestamp && (
                          <div className="text-xs text-gray-400">
                            {new Date(result.timestamp).toLocaleTimeString()}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}