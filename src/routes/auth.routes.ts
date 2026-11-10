import { Router } from 'express';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/authenticate';
import {
  registrationLimiter,
  loginLimiter,
  otpLimiter,
  refreshLimiter,
} from '../middleware/rateLimiter';
import {
  register,     registerSchema,
  verifyOtp,    verifyOtpSchema,
  resendOtp,    resendOtpSchema,
  otpStatus,    otpStatusSchema,
  login,        loginSchema,
  refresh,      refreshSchema,
  logout,
  registerPublicCreator,
  registerPublicCreatorSchema,
} from '../controllers/auth.controller';
import { changeOwnPasswordSchema, changeOwnPassword } from '../controllers/superAdmin.controller';

const router = Router();

router.post('/register',         registrationLimiter, validate(registerSchema),                register);
router.post('/register/public',  registrationLimiter, validate(registerPublicCreatorSchema),   registerPublicCreator);
router.post('/verify-otp',       otpLimiter,          validate(verifyOtpSchema),               verifyOtp);
router.post('/resend-otp',       otpLimiter,          validate(resendOtpSchema),               resendOtp);

router.patch(
  '/change-password',
  authenticate,
  validate(changeOwnPasswordSchema),
  changeOwnPassword,
);

router.get('/otp-status',   otpLimiter,          validate(otpStatusSchema, 'query'), otpStatus);

router.post('/login',    loginLimiter,           validate(loginSchema),       login);
router.post('/refresh',     refreshLimiter,  validate(refreshSchema),  refresh);
router.post('/logout',      authenticate,                                      logout);

export default router;
