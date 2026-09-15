import { z } from "zod";

// The vocabulary the whole project speaks. Keep these enums small and stable -
// the UI, the filters and the agent prompt all key off them.

export const OPERATIONAL = [
  "open",                 // operating normally
  "renovation",           // closed or partly closed for construction/refurbishment
  "closed_temporarily",   // closed for a defined short period (technical break, event)
  "seasonal_closed",      // an open-air site outside its season
  "permanently_closed",   // gone
  "unknown",              // no usable evidence found
];

// "Can I actually swim lengths here right now?" - the question this site exists to answer.
export const SWIMMABILITY = [
  "good",             // lanes generally available to the public
  "limited",          // public lanes exist but are squeezed (school groups, clubs, events)
  "poor",             // technically open, realistically not swimmable for training
  "closed_to_public", // open but not to individual swimmers
  "unknown",
];

export const RESTRICTIONS = [
  "school_groups",   // úszásoktatás / iskolai csoportok occupying lanes
  "club_training",   // egyesületi edzés
  "competition",     // verseny / event closure
  "tourist_crowds",
  "gendered_days",
  "partial_renovation",
  "reduced_hours",
  "ticket_limit",
];

export const CONFIDENCE = ["high", "medium", "low"];

export const PoolStatusSchema = z.object({
  operational: z.enum(OPERATIONAL),
  swimmability: z.enum(SWIMMABILITY),
  confidence: z.enum(CONFIDENCE),

  // Short, plain-language summaries. Hungarian first - this is a Hungarian site.
  headline_hu: z.string(),
  headline_en: z.string(),
  details_en: z.string(),

  restrictions: z.array(z.enum(RESTRICTIONS)),

  // Free-text because Hungarian pool timetables resist every schema you throw at them.
  opening_hours_summary: z.string().nullable(),
  lane_note: z.string().nullable(),

  closures: z.array(
    z.object({
      from: z.string().nullable(),
      to: z.string().nullable(),
      reason: z.string(),
    }),
  ),

  official_website: z.string().nullable(),

  // Every claim above must be traceable to one of these. No sources => low confidence.
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      quote: z.string().nullable(),
      date: z.string().nullable(),
    }),
  ),
});

/** The shape written to docs/data/status.json for a pool we could not research. */
export function unknownStatus(reason) {
  return {
    operational: "unknown",
    swimmability: "unknown",
    confidence: "low",
    headline_hu: "Nincs friss információ",
    headline_en: "No current information",
    details_en: reason,
    restrictions: [],
    opening_hours_summary: null,
    lane_note: null,
    closures: [],
    official_website: null,
    sources: [],
  };
}
