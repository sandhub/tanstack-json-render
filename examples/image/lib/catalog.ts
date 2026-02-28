import { defineCatalog } from "@tanstack-json-render/core";
import { schema } from "@tanstack-json-render/image/server";
import { standardComponentDefinitions } from "@tanstack-json-render/image/catalog";

export const imageCatalog = defineCatalog(schema, {
  components: standardComponentDefinitions,
});
