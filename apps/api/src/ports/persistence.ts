// I01 exposes only operational readiness. Domain transactions belong to later increments.
export interface PersistencePort {
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
