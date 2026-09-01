// Express 4 doesn't catch rejected promises from async route handlers on
// its own — this wrapper forwards any thrown/rejected error to next() so
// the error handler in app.js can respond with clean JSON instead of the
// request hanging or crashing the process.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
