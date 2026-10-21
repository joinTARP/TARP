export interface AppUpdateStatus {
  readonly state:
    | "idle"
    | "disabled"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  readonly currentVersion: string;
  readonly version?: string;
  readonly progress?: number;
  readonly error?: string;
}
