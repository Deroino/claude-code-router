import { Transformer, TransformerConstructor } from "@/types/transformer";
import { ConfigService } from "./config";
import Transformers from "@/transformer";
import Module from "node:module";
import { homedir } from "os";
import { join } from "path";
import { stat, readdir } from "fs/promises";

interface TransformerConfig {
  transformers: Array<{
    name: string;
    type: "class" | "module";
    path?: string;
    options?: any;
  }>;
}

export class TransformerService {
  private transformers: Map<string, Transformer | TransformerConstructor> =
    new Map();
  // Track built-in transformer names to preserve them during hot-reload
  private builtinTransformerNames: Set<string> = new Set();

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: any
  ) {}

  registerTransformer(name: string, transformer: Transformer): void {
    this.transformers.set(name, transformer);
    this.logger.info(
      `register transformer: ${name}${
        transformer.endPoint
          ? ` (endpoint: ${transformer.endPoint})`
          : " (no endpoint)"
      }`
    );
  }

  getTransformer(
    name: string
  ): Transformer | TransformerConstructor | undefined {
    return this.transformers.get(name);
  }

  getAllTransformers(): Map<string, Transformer | TransformerConstructor> {
    return new Map(this.transformers);
  }

  getTransformersWithEndpoint(): { name: string; transformer: Transformer }[] {
    const result: { name: string; transformer: Transformer }[] = [];

    this.transformers.forEach((transformer, name) => {
      // Check if it's an instance with endPoint
      if (typeof transformer === 'object' && transformer.endPoint) {
        result.push({ name, transformer });
      }
    });

    return result;
  }

  getTransformersWithoutEndpoint(): {
    name: string;
    transformer: Transformer;
  }[] {
    const result: { name: string; transformer: Transformer }[] = [];

    this.transformers.forEach((transformer, name) => {
      // Check if it's an instance without endPoint
      if (typeof transformer === 'object' && !transformer.endPoint) {
        result.push({ name, transformer });
      }
    });

    return result;
  }

  removeTransformer(name: string): boolean {
    return this.transformers.delete(name);
  }

  hasTransformer(name: string): boolean {
    return this.transformers.has(name);
  }

  async registerTransformerFromConfig(config: {
    path?: string;
    options?: any;
  }): Promise<boolean> {
    try {
      if (config.path) {
        // Clear require cache to ensure fresh load of modified plugins
        const resolvedPath = require.resolve(config.path);
        if (require.cache[resolvedPath]) {
          delete require.cache[resolvedPath];
        }

        const module = require(resolvedPath);
        if (module) {
          const instance = new module(config.options);
          // Set logger for transformer instance
          if (instance && typeof instance === "object") {
            (instance as any).logger = this.logger;
          }
          if (!instance.name) {
            throw new Error(
              `Transformer instance from ${config.path} does not have a name property.`
            );
          }
          this.registerTransformer(instance.name, instance);
          return true;
        }
      }
      return false;
    } catch (error: any) {
      this.logger.error(
        `load transformer (${config.path}) \nerror: ${error.message}\nstack: ${error.stack}`
      );
      return false;
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.registerDefaultTransformersInternal();
      await this.loadFromConfig();
      await this.loadFromPluginsDirectory();
    } catch (error: any) {
      this.logger.error(
        `TransformerService init error: ${error.message}\nStack: ${error.stack}`
      );
    }
  }

  /**
   * Reload custom transformers from config and plugins directory.
   * Built-in transformers are preserved.
   */
  async reloadCustomTransformers(): Promise<void> {
    // Remove all non-built-in transformers
    for (const name of Array.from(this.transformers.keys())) {
      if (!this.builtinTransformerNames.has(name)) {
        this.transformers.delete(name);
      }
    }
    // Reload from config and plugins
    await this.loadFromConfig();
    await this.loadFromPluginsDirectory();
    this.logger.info('Custom transformers reloaded');
  }

  private async registerDefaultTransformersInternal(): Promise<void> {
    try {
      Object.values(Transformers).forEach(
        (TransformerStatic: any) => {
          let name: string;
          if (
            "TransformerName" in TransformerStatic &&
            typeof TransformerStatic.TransformerName === "string"
          ) {
            name = TransformerStatic.TransformerName;
            this.registerTransformer(name, TransformerStatic);
          } else {
            const transformerInstance = new TransformerStatic();
            // Set logger for transformer instance
            if (
              transformerInstance &&
              typeof transformerInstance === "object"
            ) {
              (transformerInstance as any).logger = this.logger;
            }
            name = transformerInstance.name!;
            this.registerTransformer(name, transformerInstance);
          }
          // Mark as built-in to preserve during hot-reload
          this.builtinTransformerNames.add(name);
        }
      );
    } catch (error) {
      this.logger.error({ error }, "transformer regist error:");
    }
  }

  private async loadFromConfig(): Promise<void> {
    const transformers = this.configService.get<
      TransformerConfig["transformers"]
    >("transformers", []);
    // Use Promise.allSettled to load transformers in parallel
    const results = await Promise.allSettled(
      transformers.map(transformer =>
        this.registerTransformerFromConfig(transformer)
      )
    );
    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `Failed to load transformer at index ${index}: ${result.reason}`
        );
      }
    });
  }

  private async loadFromPluginsDirectory(): Promise<void> {
    try {
      const pluginsDir = join(homedir(), ".claude-code-router", "plugins");
      const dirStats = await stat(pluginsDir).catch(() => null);
      if (!dirStats || !dirStats.isDirectory()) {
        return;
      }

      const files = await readdir(pluginsDir);

      // Load plugins in parallel
      const loadPromises = files
        .filter(f => f.endsWith('.js'))
        .map(async (file) => {
          const filePath = join(pluginsDir, file);

          const transformersFromConfig = this.configService.get<
            TransformerConfig["transformers"]
          >("transformers", []);

          const isAlreadyConfigured = transformersFromConfig.some(
            t => t.path === filePath
          );

          if (!isAlreadyConfigured) {
            this.logger.info(`Loading transformer from plugins directory: ${filePath}`);
            await this.registerTransformerFromConfig({
              path: filePath,
              options: {}
            });
          }
        });

      await Promise.allSettled(loadPromises);
    } catch (error: any) {
      this.logger.warn(`Failed to load transformers from plugins directory: ${error.message}`);
    }
  }
}
