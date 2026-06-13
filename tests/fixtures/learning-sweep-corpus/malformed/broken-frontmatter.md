---
title: "Frontmatter that opens but never closes"
category: skill-design
tags:
  - broken

## Problem

The opening `---` has no closing `---` delimiter, so this is genuinely
malformed. The scan must skip it with a warning, not guess at fields, and must
still complete the rest of the index.
