import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { authenticate } from '../middleware/auth.js';
import User from '../models/User.js';
import sendEmail from '../utils/sendEmail.js';

const router = express.Router();

let razorpay;

// Initialize Razorpay client
const initializeRazorpayClient = (req, res, next) => {
  if (!razorpay) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error("❌ FATAL ERROR: Razorpay API keys are not defined in the .env file.");
      return res.status(500).json({ message: "Payment gateway is not configured." });
    }
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log('✅ Razorpay client initialized');
  }
  next();
};

router.use(initializeRazorpayClient);

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// FIXED: Prices in paise (multiply by 100)
const PLANS = {
  monthly: { amount: 999, currency: 'INR' },  // ₹999 (999 * 100 paise)
  yearly: { amount: 9900, currency: 'INR' },  // ₹9900 (9900 * 100 paise)
};

// CREATE ORDER
router.post('/create-order', authenticate, asyncHandler(async (req, res) => {
  console.log('📦 Create order request');
  console.log('User:', req.user?.email);
  console.log('Body:', req.body);

  const { plan } = req.body;

  if (!PLANS[plan]) {
    console.log('❌ Invalid plan:', plan);
    return res.status(400).json({ message: 'A valid plan (monthly/yearly) is required.' });
  }

  const options = {
    amount: PLANS[plan].amount,
    currency: PLANS[plan].currency,
    receipt: `rcpt_${crypto.randomBytes(8).toString('hex')}`,
    notes: {
      userId: req.user._id.toString(),
      plan: plan,
    }
  };

  console.log('Creating order with options:', options);

  const order = await razorpay.orders.create(options);

  console.log('✅ Order created:', order.id);

  res.status(200).json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
  });
}));

// VERIFY PAYMENT
router.post('/verify-payment', authenticate, asyncHandler(async (req, res) => {
  console.log('🔍 Verify payment request');
  console.log('User:', req.user?.email);
  console.log('Body:', req.body);

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

  // Verify signature
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    console.log('❌ Invalid signature');
    return res.status(400).json({ message: 'Invalid payment signature. Payment verification failed.' });
  }

  console.log('✅ Payment signature verified');

  const user = await User.findById(req.user._id);

  // Check if already processed
  if (user.subscription?.razorpayOrderId === razorpay_order_id) {
    console.log('⚠️ Order already processed');
    return res.status(200).json({ status: 'success', message: 'Subscription is already active.' });
  }

  // Calculate expiry date
  const expiresAt = new Date();
  if (plan === 'monthly') {
    expiresAt.setMonth(expiresAt.getMonth() + 1);
  } else if (plan === 'yearly') {
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  }

  // Update user to pro
  user.role = 'pro_user';
  user.subscription = {
    plan: plan,
    status: 'active',
    razorpayPaymentId: razorpay_payment_id,
    razorpayOrderId: razorpay_order_id,
    startDate: new Date(),
    expiresAt: expiresAt,
  };

  await user.save();

  console.log('✅ User upgraded to pro:', user.email);

  // Send receipt email
  try {
    const amountInRupees = (PLANS[plan].amount / 100).toFixed(2);
    const receiptHTML = `
      <h1>Thank you for your purchase, ${user.name}!</h1>
      <p>Your MealZen Pro subscription is now active.</p>
      <h2>Receipt Details:</h2>
      <ul>
        <li><strong>Plan:</strong> ${plan.charAt(0).toUpperCase() + plan.slice(1)}</li>
        <li><strong>Amount:</strong> ₹${amountInRupees}</li>
        <li><strong>Payment ID:</strong> ${razorpay_payment_id}</li>
        <li><strong>Order ID:</strong> ${razorpay_order_id}</li>
        <li><strong>Subscription valid until:</strong> ${expiresAt.toDateString()}</li>
      </ul>
      <p>Happy cooking!</p>
    `;
    await sendEmail({
      email: user.email,
      subject: 'Your MealZen Pro Subscription Receipt',
      html: receiptHTML
    });
    console.log('✅ Receipt email sent');
  } catch (emailError) {
    console.error("❌ Payment receipt email could not be sent:", emailError);
  }

  res.status(200).json({
    status: 'success',
    message: 'Payment verified and subscription activated successfully.',
  });
}));

// GET SUBSCRIPTION STATUS
router.get('/subscription', authenticate, (req, res) => {
  console.log('📊 Subscription status request for:', req.user?.email);
  
  const { subscription } = req.user;
  if (subscription && subscription.status === 'active' && new Date(subscription.expiresAt) > new Date()) {
    res.status(200).json({ hasSubscription: true, details: subscription });
  } else {
    res.status(200).json({ hasSubscription: false, message: 'No active subscription found.' });
  }
});

export default router;
