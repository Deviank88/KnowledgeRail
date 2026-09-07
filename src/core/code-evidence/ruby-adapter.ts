import { extractRubyKeywordBlocks } from "./keyword-block-engine.js";
import { createRubyImportResolver } from "./import-resolution/ruby.js";
import { GEMSPEC_MANIFEST } from "./import-resolution/ruby-config.js";
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
  readonly projectManifests = [GEMSPEC_MANIFEST];
  readonly parserVersion = RUBY_ADAPTER_VERSION;
  readonly extensionClaims = RUBY_EXTENSION_CLAIMS;
  readonly createImportResolver = createRubyImportResolver;

  supports(source: Pick<CodeSource, "path">): boolean {
    return supportedRubyPath(source.path);
  }

  async extract(source: CodeSource): Promise<KnowledgeFragment[]> {
    return this.supports(source) ? extractRubyKeywordBlocks(source) : [];
  }
}
