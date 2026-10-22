import assert from "node:assert/strict";
import test from "node:test";
import { urlHasPhrase } from "../../src/eval/heldout/url-oracle";

test("a query phrase matches when the URL encodes the space as +", () => {
  assert.equal(urlHasPhrase("https://hn.algolia.com/?q=Grace+Hopper", "Grace Hopper"), true);
  assert.equal(urlHasPhrase("https://hn.algolia.com/?q=Alan+Turing", "Alan Turing"), true);
});

test("a path phrase still matches the raw URL", () => {
  assert.equal(
    urlHasPhrase("https://quotes.toscrape.com/author/Albert-Einstein/", "/author/Albert-Einstein"),
    true,
  );
  assert.equal(urlHasPhrase("https://the-internet.herokuapp.com/status_codes", "status_codes"), true);
});

test("a phrase that is not in the URL still misses", () => {
  assert.equal(urlHasPhrase("https://api.jquery.com/", "get"), false);
  assert.equal(urlHasPhrase("https://hn.algolia.com/?q=Grace+Hopper", "Alan Turing"), false);
});
