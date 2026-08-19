import { extractRubyKeywordBlocks } from "./keyword-block-engine.js";
import {
  RUBY_ADAPTER_VERSION,
  type CodeSource,
  type KnowledgeAdapter,
  type KnowledgeFragment,
} from "./types.js";

export const RUBY_EXTENSION_CLAIMS = [".rb", ".rake"] as const;

function supportedRubyPath(path: string): boolean {
  const lower = path.toLowerCase();
  return RUBY_EXTENSION_CLAIMS.some((claim) => lower.endsWith(claim));
}

export class RubyKnowledgeAdapter implements KnowledgeAdapter {
  readonly parserVersion = RUBY_ADAPTER_VERSION;
  readonly extensionClaims = RUBY_EXTENSION_CLAIMS;

  supports(source: Pick<CodeSource, "path">): boolean {
    return supportedRubyPath(source.path);
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    return this.supports(source) ? extractRubyKeywordBlocks(source) : [];
  }
}
