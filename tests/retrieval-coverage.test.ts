import assert from "node:assert/strict";
import { test } from "node:test";
import { extractQueryEntities } from "../src/core/retrieval-coverage.js";

test("entity extraction ignores task verbs and ordinary slash-separated prose", () => {
  const entities = extractQueryEntities(
    "Spiegare i Lease nel progetto SilverFir: data model, automazioni/componenti, test e rilasci per Asset__c REQ-808 /services/data/v1"
  );

  assert.equal(entities.includes("Spiegare"), false);
  assert.equal(entities.includes("automazioni/componenti"), false);
  assert.equal(entities.includes("Lease"), true);
  assert.equal(entities.includes("SilverFir"), false, "project scope labels must not become retrieval entities");
  assert.equal(entities.includes("Asset__c"), true);
  assert.equal(entities.includes("REQ-808"), true);
  assert.equal(entities.includes("/services/data/v1"), true);
  assert.equal(extractQueryEntities("SilverFir Lease lifecycle").includes("SilverFir"), true);

  const guidedTaskEntities = extractQueryEntities(
    "Capire il funzionamento dei lease nel progetto SilverFir, includendo data model, automazioni e componenti, validazioni, test e rilasci, evidenziando limiti e gap documentali."
  );
  assert.equal(guidedTaskEntities.includes("Capire"), false);
  assert.equal(guidedTaskEntities.includes("lease"), true);
  assert.equal(guidedTaskEntities.includes("SilverFir"), false);
});
