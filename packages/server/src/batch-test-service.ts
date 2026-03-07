import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { BATCH_TEST_RESULTS_FILE, HOME_DIR } from "@CCR/shared";

export interface BatchTestItem {
  provider: string;
  model: string;
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
  signal?: AbortSignal
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
    tests: Array<{ provider: string; model: string }>,
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

    // Initialize results
    this.results = tests.map(t => ({
      provider: t.provider,
      model: t.model,
      status: "idle" as const,
    }));

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
            this.abortController?.signal
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
