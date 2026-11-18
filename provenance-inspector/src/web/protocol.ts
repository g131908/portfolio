// Messages between the UI thread and the analysis worker.
import type { Comparison } from '../analyzers/compare.js';
import type { InspectionReport } from '../core/inspect-file.js';

export interface FilePayload { name: string; type: string; lastModified: number; buffer: ArrayBuffer }
export interface Heatmap { width: number; height: number; buffer: ArrayBuffer; hotspot: { x: number; y: number; w: number; h: number } | null }

export type ToWorker =
  | { kind: 'inspect'; id: number; file: FilePayload }
  | { kind: 'compare'; id: number; a: FilePayload; b: FilePayload };

export type FromWorker =
  | { kind: 'report'; id: number; report: InspectionReport; ela: Heatmap | null }
  | { kind: 'comparison'; id: number; comparison: Omit<Comparison, 'diff'>; diff: Heatmap }
  | { kind: 'error'; id: number; message: string };
