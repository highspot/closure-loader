const del = require("delete");
const { dest, series, src } = require("gulp");
const pump = require("pump");

exports.dist = async (done) => {
  del("dist");
  await Promise.all(
    [
      async (done) => {
        await pump([
          src(["*.js", "!gulpfile.js", "package.json", "package-lock.json", "*.md", "LICENSE"]),
          dest("dist")
        ]);
        done();
      },
      async (done) => {
        await pump([
          src("examples/**"),
          dest("dist/examples")
        ]);
        done();
      }
    ]
    .map((job) => new Promise(async (resolve) => { await job(resolve); }))
  );
  done();
};