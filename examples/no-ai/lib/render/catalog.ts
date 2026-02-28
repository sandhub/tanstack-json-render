import { defineCatalog } from "@tanstack-json-render/core";
import { schema } from "@tanstack-json-render/react/schema";
import { shadcnComponentDefinitions } from "@tanstack-json-render/shadcn/catalog";
import { z } from "zod";

export const catalog = defineCatalog(schema, {
  components: {
    ...shadcnComponentDefinitions,
  },
  actions: {
    confetti: {
      params: z.object({}),
      description: "Fire confetti",
    },
  },
  functions: {
    formatAddress: {
      description:
        "Formats country and city into a single address string like 'City, Country'",
    },
    citiesForCountry: {
      description: "Returns an array of city names for the given country code",
    },
  },
});
