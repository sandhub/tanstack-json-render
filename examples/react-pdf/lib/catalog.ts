import { defineCatalog } from "@tanstack-json-render/core";
import { schema } from "@tanstack-json-render/react-pdf/server";
import { standardComponentDefinitions } from "@tanstack-json-render/react-pdf/catalog";

export const pdfCatalog = defineCatalog(schema, {
  components: standardComponentDefinitions,
  actions: {},
});
