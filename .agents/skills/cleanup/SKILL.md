---
name: cleanup
description: "Clean up code to make it more maintainable"
metadata:
    author: Albert Clo
---

# Cleanup

Check the code against the rules below and implement what you find. Don't stop at a
list of findings: make the changes yourself, then say what you changed.

## Scope
Unless told otherwise, clean up what the current branch changes compared to the latest
main branch, committed or not:

```
git fetch origin main
git diff $(git merge-base origin/main HEAD)
git status --short    # new files, which the diff leaves out
```

When asked for something else, such as one folder or the whole codebase, clean up that
instead.

## Remove unnecessary functions
Every function a change adds is one more thing to review and maintain, so each one has to 
earn its place. This applies to PHP, Laravel, TypeScript, Vue, etc.

### Use standard functions
Use what language standard libraries and frameworks already provide. Don't add functions
if the code could be easily adapted to use standard functions instead.

Examples: [examples/standard-functions.md](examples/standard-functions.md)

### Re-use existing code 
Before adding a helper, see if the code could easily be adapted to use an existing function
instead.

### No function that only forwards
No function that only forwards to another call with the same arguments. A small helper
  stays when its name says something the code inside it doesn't.

## Clean up as you go 
When the design changes part-way through a task, delete what the old design needed.

## Expressive code

### Expressive names
Use variable, function and class names that make it clear what they do

Examples: [examples/expressive-names.md](examples/expressive-names.md)

### Comments describe the code as it is now
Don't refer to code or behavior that was removed and is not in the codebase anymore.
What changed goes in the commit message.

Examples: [examples/comments.md](examples/comments.md)
