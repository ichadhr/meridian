export default [
  {
    test: {
      name: "unit",
      include: ["tests/{core,llm,interfaces,screening}/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "live",
      include: ["tests/live/**/*.test.ts"],
    },
  },
];
