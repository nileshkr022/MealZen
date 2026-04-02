import express from 'express';
import axios from 'axios';
import PDFDocument from 'pdfkit';
import MealPlan from '../models/MealPlan.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  const query = { createdBy: req.user._id };
  if (startDate && endDate) {
    query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
  }
  const mealPlans = await MealPlan.find(query).sort({ date: 'asc' });
  res.status(200).json(mealPlans);
}));

router.post('/', authenticate, asyncHandler(async (req, res) => {
  const { date, meal } = req.body;
  if (!date || !meal || !meal.name || !meal.type) {
    return res.status(400).json({ message: 'A valid date and meal object are required.' });
  }
  const requestedDate = new Date(date);
  const today = new Date();
  requestedDate.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);

  if (requestedDate < today) {
      return res.status(400).json({ message: "Cannot add or modify meals for past dates." });
  }

  let mealPlan = await MealPlan.findOne({ createdBy: req.user._id, date: new Date(date) });
  if (mealPlan) {
    mealPlan.meals.push(meal);
  } else {
    mealPlan = new MealPlan({
      createdBy: req.user._id,
      date: new Date(date),
      meals: [meal],
    });
  }
  await mealPlan.save();
  res.status(201).json(mealPlan);
}));

router.delete('/:planId/meals/:mealId', authenticate, asyncHandler(async (req, res) => {
    const { planId, mealId } = req.params;
    const mealPlan = await MealPlan.findOne({ _id: planId, createdBy: req.user._id });
    if (!mealPlan) {
        return res.status(404).json({ message: 'Meal plan not found.' });
    }
    const mealCountBefore = mealPlan.meals.length;
    mealPlan.meals.pull({ _id: mealId });
    if (mealPlan.meals.length === mealCountBefore) {
        return res.status(404).json({ message: 'Meal not found in this plan.' });
    }
    if (mealPlan.meals.length === 0) {
        await MealPlan.findByIdAndDelete(planId);
        res.status(200).json({ message: 'Meal deleted and empty plan removed.' });
    } else {
        await mealPlan.save();
        res.status(200).json({ message: 'Meal deleted successfully.', mealPlan });
    }
}));

router.post('/ai-generate', authenticate, authorize('pro_user'), asyncHandler(async (req, res) => {
  const { startDate, dietary, healthGoal } = req.body;
  const userPreferences = req.user.preferences;
  const generatedPlans = [];

  for (let i = 0; i < 7; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + i);
    const dateString = currentDate.toISOString().split('T')[0];

    const finalDietary = (dietary && dietary !== 'any') ? dietary : (userPreferences.dietary.join(', ') || 'a standard balanced diet');
    const finalGoal = (healthGoal && healthGoal !== 'any') ? healthGoal : (userPreferences.goals || 'general wellness');

    const prompt = `You are a highly strict meal planning AI.

TASK:
Generate a meal plan for ONE DAY only: ${dateString}.

CRITICAL RULES (MUST FOLLOW STRICTLY):

1. DIET TYPE (HIGHEST PRIORITY):
The meal plan MUST be 100% ${finalDietary}.
- If vegetarian → NO meat, NO chicken, NO fish, NO eggs.
- If non-vegetarian → Only allowed non-veg items: eggs, fish (aquatic), chicken, mutton.
- Do NOT include any other non-veg items under any condition.

2. NON-VEG LIMIT:
If diet allows non-veg → maximum 50% of total meals can contain non-veg.
The remaining meals MUST be vegetarian.

3. NO DUPLICATION:
Do NOT repeat any dish in the entire day.

4. INDIAN STYLE:
All meals MUST have an Indian touch (Indian cuisine or Indian-style preparation).

5. HEALTH GOAL:
Meals MUST support this goal: ${finalGoal}.

6. ALLERGIES (STRICT EXCLUSION):
Do NOT include any of these ingredients:
${userPreferences.allergies.join(', ') || 'none'}

7. OUTPUT FORMAT (MANDATORY):
- Return ONLY a valid JSON object.
- Do NOT include any text before or after JSON.
- Do NOT include explanations.

FORMAT:
{
  "meals": [
    {
      "name": "...",
      "type": "breakfast | lunch | dinner | snack",
      "ingredients": [
        { "name": "...", "quantity": number, "unit": "..." }
      ],
      "calories": number,
      "nutrition": {
        "protein": number,
        "carbs": number,
        "fat": number
      }
    }
  ]
}

8. INGREDIENT RULE:
- "ingredients" MUST be an array of objects
- Each object MUST have: name, quantity (number), unit

9. NUTRITION RULE:
- All nutrition values MUST be numbers ONLY (no strings, no units)

FAIL-SAFE:
If any rule conflicts, ALWAYS prioritize:
Diet type > Allergies > Non-veg limit > Other rules.

Generate now.`;



    
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: 'openai/gpt-3.5-turbo', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" }},
        { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }}
      );
      const aiDayPlan = JSON.parse(response.data.choices[0].message.content);
      const cleanedMeals = aiDayPlan.meals.map(meal => {
          delete meal.recipe;
          if (meal.ingredients && Array.isArray(meal.ingredients)) {
              meal.ingredients = meal.ingredients.map(ing => typeof ing === 'string' ? { name: ing, quantity: '', unit: '' } : ing);
          }
          if (meal.nutrition) {
              for (const key in meal.nutrition) {
                  const value = meal.nutrition[key];
                  meal.nutrition[key] = typeof value === 'string' ? parseInt(value, 10) || 0 : value;
              }
          }
          return meal;
      });
      const newPlan = await MealPlan.findOneAndUpdate(
          { createdBy: req.user._id, date: currentDate },
          { $set: { meals: cleanedMeals, isAIGenerated: true, createdBy: req.user._id } },
          { upsert: true, new: true }
      );
      generatedPlans.push(newPlan);
    } catch (error) {
        console.error(`Failed to generate plan for ${dateString}:`, error.message);
    }
  }
  if (generatedPlans.length === 0) {
      return res.status(500).json({ message: 'AI failed to generate any meal plans. Please try again.' });
  }
  res.status(201).json({ message: `${generatedPlans.length} days of meal plans generated successfully.`, plans: generatedPlans });
}));

router.post('/export', authenticate, authorize('pro_user'), asyncHandler(async (req, res) => {
    const { startDate } = req.body;
    const startOfWeek = new Date(startDate);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);

    const mealPlans = await MealPlan.find({
        createdBy: req.user._id,
        date: { $gte: startOfWeek, $lte: endOfWeek }
    }).sort({ date: 'asc' });

    const doc = new PDFDocument({ margin: 50 });
    const filename = `Meal-Plan-${startOfWeek.toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(24).font('Helvetica-Bold').text('Your Weekly Meal Plan', { align: 'center' });
    doc.fontSize(16).font('Helvetica').text(`${startOfWeek.toDateString()} - ${endOfWeek.toDateString()}`, { align: 'center' });
    doc.moveDown(2);

    if (mealPlans.length === 0) {
        doc.fontSize(12).text('No meals planned for this week.', { align: 'center' });
    } else {
        mealPlans.forEach(plan => {
            const dayOfWeek = new Date(plan.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            doc.fontSize(18).font('Helvetica-Bold').text(dayOfWeek, { underline: true });
            doc.moveDown(0.5);
            if (plan.meals.length > 0) {
                plan.meals.forEach(meal => {
                    doc.fontSize(14).font('Helvetica-Bold').text(`${meal.type.charAt(0).toUpperCase() + meal.type.slice(1)}: ${meal.name}`);
                    doc.fontSize(10).font('Helvetica').list(meal.ingredients.map(ing => `${ing.quantity || ''} ${ing.unit || ''} ${ing.name}`.trim()), { bulletRadius: 2 });
                    doc.moveDown(1);
                });
            } else {
                doc.fontSize(12).font('Helvetica-Oblique').text('No meals planned for this day.', { indent: 20 });
                doc.moveDown(1);
            }
        });
    }
    doc.end();
}));

export default router;
