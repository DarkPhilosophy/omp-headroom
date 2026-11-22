// Archive tests must not inherit host config (~/.omp/agent/headroom.yml):
// env beats YAML in src/config.ts, so force the feature on for the suite.
process.env.OMP_HEADROOM_SESSION_COMPACTION = "on";

export {};
