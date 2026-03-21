declare module "mammoth" {
  interface ExtractResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  interface InputOptions {
    buffer: Buffer;
  }
  export function extractRawText(options: InputOptions): Promise<ExtractResult>;
  export function convertToHtml(options: InputOptions): Promise<ExtractResult>;
}
