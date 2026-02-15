
const Video = require(SUPABASE_IMAGE_BUCKET); 
const User = require(SUPABASE_VIDEO_BUCKET);   

// Helper: Get time category (used only at signup, not on every request)
const getTimeCategory = (date) => {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
};

// Base video score (views, likes, recency)
const calculateVideoScore = (video) => {
  const now = new Date();
  const daysSinceUpload = (now - video.uploadTime) / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 30 - daysSinceUpload); // max 30 days
  return (video.views * 0.6) + (video.likes * 0.3) + (recencyScore * 0.1);
};

// Personalized score: boosts videos matching user favorite category/time
const personalizedScore = (video, user) => {
  let score = calculateVideoScore(video);

  // Boost for user favorite category
  if (user.favoriteCategories && user.favoriteCategories.includes(video.category)) {
    score += 20;
  }

  // Boost for user favorite time (calculated at signup)
  if (user.favoriteTime && video.uploadTimeCategory === user.favoriteTime) {
    score += 50;
  }

  return score;
};

// Shuffle array (Fisher-Yates)
const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// Controller: get recommended videos
const getRecommendedVideos = async (req, res) => {
  try {
    const userId = req.user.id; // assume auth middleware
    const user = await User.findById(userId);

    // Fetch all videos (can paginate for large DB)
    const videos = await Video.find({});

    // Score each video
    const scoredVideos = videos.map(video => ({
      video,
      score: personalizedScore(video, user)
    }));

    // Sort descending by score
    scoredVideos.sort((a, b) => b.score - a.score);

    // Extract sorted videos
    let recommendedVideos = scoredVideos.map(item => item.video);

    // Shuffle top N videos to introduce variety
    const topN = 20;
    const topVideos = recommendedVideos.slice(0, topN);
    const restVideos = recommendedVideos.slice(topN);

    recommendedVideos = [...shuffleArray(topVideos), ...restVideos];

    res.json({ recommendedVideos });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error generating recommendations" });
  }
};

module.exports = { getRecommendedVideos };
