// `pnpm run schema [out]`: writes the JSON Schema (draft 2020-12) of the `--format=json` envelope, generated from
// the zod schema, to `out` (default `schema/digest-envelope.schema.json`). Node strips the types of the `.ts` import.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DigestEnvelopeSchema } from "../src/types/schema.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(root, "schema", "digest-envelope.schema.json"));

const { $schema: _draft, ...body } = zodToJsonSchema(DigestEnvelopeSchema, {
  target: "jsonSchema7",
  $refStrategy: "none",
});
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "dot-test-digest envelope (--format=json)",
  ...body,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
