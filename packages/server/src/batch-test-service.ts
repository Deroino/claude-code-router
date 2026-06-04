import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { BATCH_TEST_RESULTS_FILE, HOME_DIR } from "@CCR/shared";

export interface BatchTestItem {
  provider: string;
  model: string;
  keyIndex?: number;
  status: "idle" | "testing" | "success" | "error" | "cancelled";
  message?: string;
  response?: string;
  timestamp?: number;
}

export interface BatchTestStatus {
  status: "idle" | "running" | "cancelling" | "completed";
  progress: { completed: number; total: number };
  concurrency: number;
  startedAt: number | null;
  completedAt: number | null;
  results: BatchTestItem[];
}

type ExecuteModelTestFn = (
  provider: string,
  model: string,
  message?: string,
  signal?: AbortSignal,
  keyIndex?: number
) => Promise<{ success: boolean; status?: number; response?: string; error?: string }>;

/**
 * Singleton service that manages batch model testing on the backend.
 * Runs tests with configurable concurrency, persists results to file,
 * and supports cancellation via AbortController.
 */
class BatchTestService {
  private taskStatus: "idle" | "running" | "cancelling" | "completed" = "idle";
  private results: BatchTestItem[] = [];
  private concurrency: number = 20;
  private startedAt: number | null = null;
  private completedAt: number | null = null;
  private abortController: AbortController | null = null;
  private testMessage: string | undefined = undefined;

  /**
   * Start a batch test task. Returns false if a task is already running.
   */
  start(
    tests: Array<{ provider: string; model: string; keyIndex?: number }>,
    concurrency: number,
    executeModelTest: ExecuteModelTestFn,
    testMessage?: string
  ): boolean {
    if (this.taskStatus === "running" || this.taskStatus === "cancelling") {
      return false;
    }

    this.taskStatus = "running";
    this.concurrency = concurrency;
    this.startedAt = Date.now();
    this.completedAt = null;
    this.testMessage = testMessage;
    this.abortController = new AbortController();

    // Load previously persisted results for merging
    const previousResults = this.loadPersistedResults();

    // Build a set of keys for tests being re-run
    const rerunKeys = new Set<string>();
    for (const t of tests) {
      const key = t.keyIndex !== undefined
        ? `${t.provider}-${t.model}-key${t.keyIndex}`
        : `${t.provider}-${t.model}`;
      rerunKeys.add(key);
    }

    // Merge: preserve previous results, reset only re-run tests to idle
    const mergedResults: BatchTestItem[] = [];
    const addedKeys = new Set<string>();

    // Process previous results first (maintain original order)
    for (const r of previousResults) {
      const key = r.keyIndex !== undefined
        ? `${r.provider}-${r.model}-key${r.keyIndex}`
        : `${r.provider}-${r.model}`;
      if (rerunKeys.has(key)) {
        // Reset to idle for re-testing
        mergedResults.push({
          provider: r.provider,
          model: r.model,
          ...(r.keyIndex !== undefined ? { keyIndex: r.keyIndex } : {}),
          status: "idle" as const,
        });
      } else {
        // Keep previous result unchanged
        mergedResults.push(r);
      }
      addedKeys.add(key);
    }

    // Add any new tests not present in previous results
    for (const t of tests) {
      const key = t.keyIndex !== undefined
        ? `${t.provider}-${t.model}-key${t.keyIndex}`
        : `${t.provider}-${t.model}`;
      if (!addedKeys.has(key)) {
        mergedResults.push({
          provider: t.provider,
          model: t.model,
          ...(t.keyIndex !== undefined ? { keyIndex: t.keyIndex } : {}),
          status: "idle" as const,
        });
      }
    }

    this.results = mergedResults;

    // Persist initial state
    this.persistResults();

    // Run tests in the background (don't await)
    this.runTests(executeModelTest).catch(err => {
      console.error("[BatchTestService] Unexpected error in runTests:", err);
      this.taskStatus = "completed";
      this.completedAt = Date.now();
      this.persistResults();
    });

    return true;
  }

  /**
   * Cancel the currently running batch test task.
   */
  cancel(): { success: boolean; completed: number; cancelled: number } {
    if (this.taskStatus !== "running") {
      return { success: false, completed: 0, cancelled: 0 };
    }

    this.taskStatus = "cancelling";
    this.abortController?.abort();

    const completed = this.results.filter(r => r.status === "success" || r.status === "error").length;
    const cancelled = this.results.filter(r => r.status === "idle" || r.status === "testing").length;

    return { success: true, completed, cancelled };
  }

  clear(): { success: boolean; removed: number; error?: string } {
    if (this.taskStatus === "running" || this.taskStatus === "cancelling") {
      return { success: false, removed: 0, error: "A batch test is currently running" };
    }

    const removed = this.results.length || this.loadPersistedResults().length;
    this.results = [];
    this.taskStatus = "idle";
    this.startedAt = null;
    this.completedAt = null;
    this.persistResults();

    return { success: true, removed };
  }

  clearProvider(provider: string): { success: boolean; removed: number; error?: string } {
    if (this.taskStatus === "running" || this.taskStatus === "cancelling") {
      return { success: false, removed: 0, error: "A batch test is currently running" };
    }

    const sourceResults = this.results.length > 0 ? this.results : this.loadPersistedResults();
    const nextResults = sourceResults.filter(item => item.provider !== provider);
    const removed = sourceResults.length - nextResults.length;

    if (nextResults.length === 0) {
      this.taskStatus = "idle";
      this.startedAt = null;
      this.completedAt = null;
    }

    if (removed > 0 || this.results.length === 0) {
      this.results = nextResults;
      this.persistResults();
    }

    return { success: true, removed };
  }

  /**
   * Get the current status and all results.
   */
  getStatus(): BatchTestStatus {
    return {
      status: this.taskStatus,
      progress: {
        completed: this.results.filter(r =>
          r.status === "success" || r.status === "error" || r.status === "cancelled"
        ).length,
        total: this.results.length,
      },
      concurrency: this.concurrency,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      results: this.results,
    };
  }

  /**
   * Load previously persisted results from file.
   */
  private loadPersistedResults(): BatchTestItem[] {
    try {
      if (existsSync(BATCH_TEST_RESULTS_FILE)) {
        const data = JSON.parse(readFileSync(BATCH_TEST_RESULTS_FILE, "utf-8"));
        if (data?.results?.length > 0) {
          return data.results;
        }
      }
    } catch {
      // Ignore read errors
    }
    return [];
  }

  /**
   * Run all tests with concurrency control using a worker queue pattern.
   */
  private async runTests(executeModelTest: ExecuteModelTestFn): Promise<void> {
    const queue = this.results
      .map((_, index) => index)
      .filter(i => this.results[i].status === "idle");

    const runNext = async (): Promise<void> => {
      while (queue.length > 0) {
        // Check if cancelled
        if (this.abortController?.signal.aborted) {
          return;
        }

        const index = queue.shift()!;
        const item = this.results[index];

        // Mark as testing
        this.results[index] = { ...item, status: "testing", timestamp: Date.now() };

        try {
          const result = await executeModelTest(
            item.provider,
            item.model,
            this.testMessage,
            this.abortController?.signal,
            item.keyIndex
          );

          // Check if cancelled during execution
          if (this.abortController?.signal.aborted) {
            if (result.status === 499 || result.error === "Cancelled") {
              this.results[index] = {
                ...item,
                status: "cancelled",
                message: "Cancelled",
                timestamp: Date.now(),
              };
            } else {
              // Request completed before abort signal, keep the result
              this.results[index] = {
                provider: item.provider,
                model: item.model,
                ...(item.keyIndex !== undefined ? { keyIndex: item.keyIndex } : {}),
                status: result.success ? "success" : "error",
                message: result.error || undefined,
                response: result.response || undefined,
                timestamp: Date.now(),
              };
            }
          } else {
            this.results[index] = {
              provider: item.provider,
              model: item.model,
              ...(item.keyIndex !== undefined ? { keyIndex: item.keyIndex } : {}),
              status: result.success ? "success" : "error",
              message: result.error || undefined,
              response: result.response || undefined,
              timestamp: Date.now(),
            };
          }
        } catch (err: any) {
          this.results[index] = {
            ...item,
            status: "error",
            message: err.message || "Unknown error",
            timestamp: Date.now(),
          };
        }

        // Persist after each test
        this.persistResults();
      }
    };

    // Launch concurrent workers
    const workerCount = Math.min(this.concurrency, queue.length);
    const workers = Array.from({ length: workerCount }, () => runNext());
    await Promise.all(workers);

    // Mark remaining idle items as cancelled if task was cancelled
    if (this.abortController?.signal.aborted) {
      for (let i = 0; i < this.results.length; i++) {
        if (this.results[i].status === "idle" || this.results[i].status === "testing") {
          this.results[i] = {
            ...this.results[i],
            status: "cancelled",
            message: "Cancelled",
            timestamp: Date.now(),
          };
        }
      }
    }

    this.taskStatus = "completed";
    this.completedAt = Date.now();
    this.persistResults();
  }

  /**
   * Persist current results to the batch test results file.
   */
  private persistResults(): void {
    try {
      if (!existsSync(HOME_DIR)) {
        mkdirSync(HOME_DIR, { recursive: true });
      }
      writeFileSync(
        BATCH_TEST_RESULTS_FILE,
        JSON.stringify({
          results: this.results,
          startedAt: this.startedAt,
          completedAt: this.completedAt,
        }, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.error("[BatchTestService] Failed to persist results:", err);
    }
  }
}

// Singleton instance
export const batchTestService = new BatchTestService();
