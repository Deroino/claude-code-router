import { Pencil, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import type { Provider } from "@/types";

interface ProviderListProps {
  providers: Provider[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  showToast: (message: string, type: 'success' | 'error' | 'warning') => void;
}

export function ProviderList({ providers, onEdit, onRemove, showToast }: ProviderListProps) {
  // Handle case where providers might be null or undefined
  if (!providers || !Array.isArray(providers)) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-center rounded-md border bg-white p-8 text-gray-500">
          No providers configured
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {providers.map((provider, index) => {
        // Handle case where individual provider might be null or undefined
        if (!provider) {
          return (
            <div key={index} className="flex items-start justify-between rounded-md border bg-white p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.01]">
              <div className="flex-1 space-y-1.5">
                <p className="text-md font-semibold text-gray-800">Invalid Provider</p>
                <p className="text-sm text-gray-500">Provider data is missing</p>
              </div>
              <div className="ml-4 flex flex-shrink-0 items-center gap-2">
                <Button variant="ghost" size="icon" onClick={() => onEdit(index)} className="transition-all-ease hover:scale-110" disabled>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="destructive" size="icon" onClick={() => onRemove(index)} className="transition-all duration-200 hover:scale-110">
                  <Trash2 className="h-4 w-4 text-current transition-colors duration-200" />
                </Button>
              </div>
            </div>
          );
        }

        // Handle case where provider.name might be null or undefined
        const providerName = provider.name || "Unnamed Provider";
        
        // Handle case where provider.api_base_url might be null or undefined
        const apiBaseUrl = provider.api_base_url || "No API URL";
        
        // Handle case where provider.models might be null or undefined
        const models = Array.isArray(provider.models) ? provider.models : [];

        return (
          <div key={index} className="flex items-start justify-between rounded-md border bg-white p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.01]">
            <div className="flex-1 space-y-1.5">
              <p className="text-md font-semibold text-gray-800">{providerName}</p>
              <p className="text-sm text-gray-500">{apiBaseUrl}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                {models.map((model, modelIndex) => (
                  // Handle case where model might be null or undefined
                  <Badge
                    key={modelIndex}
                    variant="outline"
                    className="font-normal transition-all-ease hover:scale-105 cursor-pointer pr-1 flex items-center gap-1"
                    onClick={async (e) => {
                      // 阻止事件冒泡，防止点击Badge整体时触发两次（如果未来有其他逻辑）
                      // 目前主要逻辑都在这里，暂时不需要 e.stopPropagation()

                      const textToCopy = `${providerName},${model}`;
                      try {
                        await navigator.clipboard.writeText(textToCopy);
                        showToast(`"${textToCopy}" copied to clipboard!`, 'success');
                      } catch (err) {
                        console.error('Failed to copy text: ', err);
                        showToast('Failed to copy to clipboard.', 'error');
                      }
                    }}
                  >
                    <span>{model || "Unnamed Model"}</span>
                    <span
                      className="p-0.5 rounded-full hover:bg-gray-200 transition-colors"
                      title="Test availability"
                      onClick={async (e) => {
                        e.stopPropagation(); // 阻止触发 Badge 的复制事件

                        const textToTest = `${providerName},${model}`;
                        showToast(`Testing ${textToTest}...`, 'warning');

                        try {
                          const result = await api.testModel(providerName, model || "", "hello");
                          if (result?.success) {
                            showToast(`"${textToTest}" test OK`, 'success');
                          } else {
                            showToast(`"${textToTest}" test failed`, 'error');
                          }
                        } catch (err) {
                          console.error('Model test failed: ', err);
                          let detail = 'Unknown error';
                          if (err && typeof err === 'object') {
                            const anyErr = err as { body?: string; message?: string };
                            if (anyErr.body) {
                              try {
                                const parsed = JSON.parse(anyErr.body);
                                detail = parsed?.error?.message || parsed?.message || anyErr.body;
                              } catch {
                                detail = anyErr.body;
                              }
                            } else if (anyErr.message) {
                              detail = anyErr.message;
                            }
                          }
                          showToast(`"${textToTest}" test failed: ${detail}`, 'error');
                        }
                      }}
                    >
                      <Zap className="h-3 w-3 text-amber-500 fill-amber-500" />
                    </span>
                  </Badge>
                ))}
              </div>
            </div>
            <div className="ml-4 flex flex-shrink-0 items-center gap-2">
              <Button variant="ghost" size="icon" onClick={() => onEdit(index)} className="transition-all-ease hover:scale-110">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="destructive" size="icon" onClick={() => onRemove(index)} className="transition-all duration-200 hover:scale-110">
                <Trash2 className="h-4 w-4 text-current transition-colors duration-200" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}