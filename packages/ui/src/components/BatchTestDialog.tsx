import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, X, Copy, Download, Filter, Search, XCircle, Play, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useTranslation } from "react-i18next";

export interface BatchTestResult {
  provider: string;
  model: string;
  status: "success" | "error" | "pending" | "testing" | "idle" | "cancelled";
  message?: string;
  response?: string;
  timestamp?: number;
}

interface BatchTestDialogProps {
  open: boolean;
  onClose: () => void;
  results: BatchTestResult[];
  title?: string;
  onRunTests?: (selectedTests: BatchTestResult[]) => void;
  onCancel?: () => void;
  isRunning?: boolean;
  concurrency?: number;
  onConcurrencyChange?: (value: number) => void;
}

export function BatchTestDialog({
  open,
  onClose,
  results,
  title,
  onRunTests,
  onCancel,
  isRunning = false,
  concurrency = 20,
  onConcurrencyChange,
}: BatchTestDialogProps) {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error" | "testing" | "idle">("all");
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set());

  // Initialize selected tests when results change
  useEffect(() => {
    if (open && results.length > 0) {
      // By default select all idle or pending tests
      const initialSelection = new Set<string>();
      results.forEach((r, index) => {
        const id = `${r.provider}-${r.model}-${index}`;
        initialSelection.add(id);
      });
      setSelectedTests(initialSelection);
    }
  }, [open, results.length]);

  const filteredResults = results.map((r, index) => ({...r, id: `${r.provider}-${r.model}-${index}`})).filter(r => {
    // Apply status filter
    if (statusFilter === "all") {
      // pass
    } else if (statusFilter === "testing") {
      if (r.status !== "testing" && r.status !== "pending") return false;
    } else {
      if (r.status !== statusFilter) return false;
    }

    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const providerMatch = r.provider && r.provider.toLowerCase().includes(term);
      const modelMatch = r.model && r.model.toLowerCase().includes(term);
      const messageMatch = r.message && typeof r.message === 'string' && r.message.toLowerCase().includes(term);
      const responseMatch = r.response && typeof r.response === 'string' && r.response.toLowerCase().includes(term);
      if (!providerMatch && !modelMatch && !messageMatch && !responseMatch) return false;
    }

    return true;
  });

  const successCount = results.filter(r => r.status === "success").length;
  const errorCount = results.filter(r => r.status === "error").length;
  const testingCount = results.filter(r => r.status === "testing" || r.status === "pending").length;
  const completedCount = results.filter(r => r.status === "success" || r.status === "error" || r.status === "cancelled").length;

  const handleCopyResults = () => {
    const text = filteredResults.map(r => {
      const statusIcon = r.status === "success" ? "✓" : r.status === "error" ? "✗" : r.status === "testing" ? "⟳" : r.status === "cancelled" ? "⊘" : "?";
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

  const toggleSelection = (id: string) => {
    setSelectedTests(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllSelection = () => {
    if (selectedTests.size === filteredResults.length) {
      setSelectedTests(new Set());
    } else {
      const next = new Set<string>();
      filteredResults.forEach(r => next.add(r.id));
      setSelectedTests(next);
    }
  };

  const handleRunSelectedTests = () => {
    if (onRunTests) {
      const selected = results.filter((_, index) => {
        const r = results[index];
        const id = `${r.provider}-${r.model}-${index}`;
        return selectedTests.has(id);
      });
      onRunTests(selected);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] flex flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{title || t("batch_test.title")}</span>
            {isRunning && (
              <span className="text-sm font-normal text-gray-500 animate-pulse">
                {t("batch_test.backend_running")} [{completedCount}/{results.length}]
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Filter and Actions */}
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <div className="flex gap-2">
              <Button
                variant={statusFilter === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter("all")}
              >
                {t("batch_test.all")} ({results.length})
              </Button>
              <Button
                variant={statusFilter === "success" ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter("success")}
              >
                <Check className="h-3 w-3 mr-1" />
                {t("batch_test.success")} ({successCount})
              </Button>
              <Button
                variant={statusFilter === "error" ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter("error")}
              >
                <X className="h-3 w-3 mr-1" />
                {t("batch_test.failed")} ({errorCount})
              </Button>
            </div>
          </div>

          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <Input
                placeholder={t("batch_test.search")}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 w-48"
              />
              {searchTerm && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                  onClick={() => setSearchTerm("")}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyResults}
            >
              <Copy className="h-4 w-4 mr-1" />
              {t("batch_test.copy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadResults}
            >
              <Download className="h-4 w-4 mr-1" />
              {t("batch_test.export")}
            </Button>
          </div>
        </div>

        {/* Results Table */}
        <div className="flex-grow overflow-y-auto border rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th className="w-10 p-3 border-b text-center whitespace-nowrap">
                  <Checkbox
                    checked={selectedTests.size > 0 && selectedTests.size === filteredResults.length}
                    onCheckedChange={toggleAllSelection}
                    aria-label={t("batch_test.select_all")}
                  />
                </th>
                <th className="text-left p-3 font-medium border-b whitespace-nowrap">{t("batch_test.provider")}</th>
                <th className="text-left p-3 font-medium border-b whitespace-nowrap">{t("batch_test.model")}</th>
                <th className="text-left p-3 font-medium border-b whitespace-nowrap">{t("batch_test.status")}</th>
                <th className="text-left p-3 font-medium border-b">{t("batch_test.details")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center p-8 text-gray-500">
                    {t("batch_test.no_results")}
                  </td>
                </tr>
              ) : (
                filteredResults.map((result) => (
                  <tr
                    key={result.id}
                    className={`border-b hover:bg-gray-50 ${selectedTests.has(result.id) ? 'bg-blue-50/50' : ''}`}
                    onClick={() => toggleSelection(result.id)}
                  >
                    <td className="p-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedTests.has(result.id)}
                        onCheckedChange={() => toggleSelection(result.id)}
                      />
                    </td>
                    <td className="p-3 font-medium whitespace-nowrap">{result.provider}</td>
                    <td className="p-3 font-mono text-xs whitespace-nowrap">{result.model}</td>
                    <td className="p-3 whitespace-nowrap">
                      {result.status === "success" && (
                        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">
                          <Check className="h-3 w-3 mr-1" />
                          {t("batch_test.success_status")}
                        </Badge>
                      )}
                      {result.status === "error" && (
                        <Badge className="bg-rose-100 text-rose-700 border-rose-200">
                          <X className="h-3 w-3 mr-1" />
                          {t("batch_test.failed_status")}
                        </Badge>
                      )}
                      {result.status === "testing" && (
                        <Badge className="bg-amber-100 text-amber-700 border-amber-200 animate-pulse">
                          {t("batch_test.testing_status")}
                        </Badge>
                      )}
                      {result.status === "pending" && (
                        <Badge variant="outline">
                          {t("batch_test.pending")}
                        </Badge>
                      )}
                      {result.status === "idle" && (
                        <Badge variant="outline" className="text-gray-500 border-gray-200">
                          {t("batch_test.idle")}
                        </Badge>
                      )}
                      {result.status === "cancelled" && (
                        <Badge variant="outline" className="text-orange-500 border-orange-200">
                          {t("batch_test.cancelled_status")}
                        </Badge>
                      )}
                    </td>
                    <td className="p-3 min-w-[300px]">
                      <div className="space-y-1">
                        {result.message && (
                          <div className="text-xs text-gray-600">
                            {typeof result.message === 'string' ? result.message : JSON.stringify(result.message)}
                          </div>
                        )}
                        {result.response && (
                          <div className="text-xs text-gray-500 max-w-md truncate" title={typeof result.response === 'string' ? result.response : JSON.stringify(result.response)}>
                            {typeof result.response === 'string' ? result.response : JSON.stringify(result.response)}
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

        <DialogFooter className="flex justify-between sm:justify-between items-center">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">
              {t("batch_test.selected", { count: selectedTests.size })}
            </span>
            {/* Concurrency input */}
            {onConcurrencyChange && (
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-gray-500">{t("batch_test.concurrency")}:</span>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={concurrency}
                  onChange={(e) => onConcurrencyChange(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="w-16 h-8 text-sm"
                  disabled={isRunning}
                />
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("batch_test.close")}
            </Button>
            {isRunning && onCancel && (
              <Button
                variant="destructive"
                onClick={onCancel}
                className="gap-2"
              >
                <Square className="h-4 w-4" />
                {t("batch_test.cancel")}
              </Button>
            )}
            {!isRunning && onRunTests && (
              <Button
                onClick={handleRunSelectedTests}
                disabled={selectedTests.size === 0}
                className="gap-2"
              >
                <Play className="h-4 w-4" />
                {t("batch_test.run_selected")}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
