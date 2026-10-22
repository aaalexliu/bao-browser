// Deliberately bad intent texts. Scored with the existing judge rubric.
// These are not added to the calibration labels, and the rubric is not changed.

import type { HandLabel } from "../intent/labels";

export const BAD_INTENT_TEXTS: HandLabel[] = [
  { id: "b1", kind: "step", good: false, text: "Click button." },
  { id: "b2", kind: "step", good: false, text: "Click the button." },
  { id: "b3", kind: "step", good: false, text: "Do the thing." },
  { id: "b4", kind: "step", good: false, text: "Type HeldOutDemoSecret! into the password field." },
  { id: "b5", kind: "step", good: false, text: "Type pin-9999 to unlock the account." },
  { id: "b6", kind: "step", good: false, text: "Type SuperSecretPassword! and log in." },
  { id: "b7", kind: "step", good: false, text: "Delete the search field." },
  { id: "b8", kind: "step", good: false, text: "Uncheck subscribe and clear the form." },
  { id: "b9", kind: "step", good: false, text: "Type Ada Lovelace into the search box." },
  { id: "b10", kind: "step", good: false, text: "Open the Help menu." },
];
