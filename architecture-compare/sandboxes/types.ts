/**
 * Shared types for the modular benchmark harness
 */

export interface Task {
  id: string;
  name: string;
  description: string;
  dataFile: string;
  dataFiles?: string[];
  expectedValue: () => number;
  tolerance: number;

  // Architecture-specific identifiers
  functionName: string;      // typed, drizzle
  sqlFile: string;          // dbt
  measureName: string;      // cube
  signature: string;        // typed
}

export interface ValidationResult {
  valid: boolean;
  actual?: number;
  error?: string;
}

export interface SurfaceDefinition {
  app: string[];
  dbt: string[];
}

export interface SurfaceTouchSummary {
  touched: boolean;
  count: number;
}

export interface CrossLayerTelemetry {
  touched_app_surface: SurfaceTouchSummary;
  touched_dbt_surface: SurfaceTouchSummary;
  cross_layer_traversal: boolean;
}

export interface SandboxConfig {
  id: string;
  name: string;

  // Files to show the LLM as context
  contextFiles: string[];

  // Primary file where the LLM should write
  targetFile: string;

  // System prompt for this architecture
  systemPrompt: string;

  // Optional telemetry mapping for cross-layer audits
  surfaceTelemetry?: SurfaceDefinition;

  // Generate task-specific prompt
  taskPrompt: (task: Task) => string;

  // Validate the result after agent completes
  validate: (sandboxDir: string, task: Task) => Promise<ValidationResult>;

  // Optional lint step before validation
  lint?: (
    sandboxDir: string,
    task: Task,
    options?: { mode?: 'full' | 'schema' }
  ) => Promise<ValidationResult>;

  // Optional: setup hook (e.g., install dependencies, create db)
  setup?: (sandboxDir: string) => Promise<void>;
}

export interface BenchmarkResult {
  sandbox: string;
  model: string;
  task: Task;
  pass: boolean;
  expected: number;
  actual?: number;
  turns: number;
  error?: string;
  durationMs: number;
  toolUsage?: {
    readFiles: string[];
    listFiles: string[];
    writeFiles: string[];
  };
  lint?: {
    valid: boolean;
    error?: string;
  };
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  rubric?: {
    runtime: number;
    output: number;
    schema: number;
    toolUsage: number;
    total: number;
  };
  telemetry?: CrossLayerTelemetry;
}
