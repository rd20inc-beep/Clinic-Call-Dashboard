const { validateIncomingCall, validateHeartbeat, validateLogin } = require('../utils/validators');

// Factory: create validation middleware from a validator function
function validate(validatorFn) {
  return (req, res, next) => {
    const result = validatorFn(req.body);
    if (!result.valid) {
      return res.status(400).json({ error: 'Validation failed', details: result.errors });
    }
    // Attach sanitized data
    req.validated = result.sanitized;
    next();
  };
}

module.exports = {
  validateIncomingCallMw: validate(validateIncomingCall),
  validateHeartbeatMw: validate(validateHeartbeat),
  validateLoginMw: validate(validateLogin),
};
