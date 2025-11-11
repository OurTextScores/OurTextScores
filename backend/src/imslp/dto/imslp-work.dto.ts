export interface ImslpWorkDto {
  workId: string;
  title: string;
  composer?: string;
  permalink: string;
  metadata: Record<string, unknown>;
}

export interface EnsureWorkResult {
  workId: string;
  metadata: ImslpWorkDto;
}
