import { eq, like, or, sql } from "drizzle-orm";
import { db } from "../db";
import { skillCategories, skillsTable, type Skill } from "@shared/schema";
import { generateEmbedding, cosineSimilarity } from "./embeddings";
import { logger } from "./logger";
import stringSimilarity from "string-similarity";
import { escoExtractor, type ESCOSkill } from "./esco-skill-extractor";

// Enhanced skill dictionary with categories (now including ESCO domains)
export const SKILL_CATEGORIES = {
  PROGRAMMING_LANGUAGES: "Programming Languages",
  FRAMEWORKS: "Frameworks & Libraries",
  DATABASES: "Databases",
  CLOUD_PLATFORMS: "Cloud Platforms",
  DEVOPS: "DevOps & Infrastructure",
  SOFT_SKILLS: "Soft Skills",
  METHODOLOGIES: "Methodologies",
  DESIGN: "Design & UI/UX",
  TESTING: "Testing & QA",
  DATA_SCIENCE: "Data Science & Analytics",
  MOBILE: "Mobile Development",
  SECURITY: "Security & Compliance",
  BUSINESS: "Business & Domain Knowledge",
  // ESCO Pharmaceutical Categories
  CLINICAL_RESEARCH: "Clinical Research",
  PHARMACEUTICAL_MANUFACTURING: "Pharmaceutical Manufacturing", 
  DRUG_DISCOVERY: "Drug Discovery",
  REGULATORY_AFFAIRS: "Regulatory Affairs",
  MEDICAL_AFFAIRS: "Medical Affairs",
  BIOTECHNOLOGY: "Biotechnology",
  QUALITY_ASSURANCE: "Quality Assurance",
  PHARMACOVIGILANCE: "Pharmacovigilance",
};

// Enhanced skill mappings with category assignments
export const ENHANCED_SKILL_DICTIONARY: Record<
  string,
  {
    normalized: string;
    category: string;
    aliases: string[];
    level?: "beginner" | "intermediate" | "advanced";
    relatedSkills?: string[];
  }
> = {
  // Programming Languages
  javascript: {
    normalized: "JavaScript",
    category: SKILL_CATEGORIES.PROGRAMMING_LANGUAGES,
    aliases: ["js", "ecmascript", "es6", "es2015", "node.js", "nodejs"],
    relatedSkills: ["TypeScript", "React", "Node.js", "Vue.js"],
  },
  python: {
    normalized: "Python",
    category: SKILL_CATEGORIES.PROGRAMMING_LANGUAGES,
    aliases: ["python3", "py"],
    relatedSkills: ["Django", "Flask", "FastAPI", "pandas", "NumPy"],
  },
  typescript: {
    normalized: "TypeScript",
    category: SKILL_CATEGORIES.PROGRAMMING_LANGUAGES,
    aliases: ["ts"],
    relatedSkills: ["JavaScript", "Angular", "React", "Node.js"],
  },

  // Frameworks & Libraries
  react: {
    normalized: "React",
    category: SKILL_CATEGORIES.FRAMEWORKS,
    aliases: ["reactjs", "react.js", "reactnative", "react-native"],
    relatedSkills: ["JavaScript", "TypeScript", "Redux", "Next.js"],
  },
  angular: {
    normalized: "Angular",
    category: SKILL_CATEGORIES.FRAMEWORKS,
    aliases: ["angularjs", "angular2", "angular4", "angular8", "angular10"],
    relatedSkills: ["TypeScript", "RxJS", "NgRx"],
  },
  vue: {
    normalized: "Vue.js",
    category: SKILL_CATEGORIES.FRAMEWORKS,
    aliases: ["vuejs", "vue.js", "vue3", "nuxt", "nuxtjs"],
    relatedSkills: ["JavaScript", "TypeScript", "Vuex"],
  },

  // Cloud Platforms
  aws: {
    normalized: "Amazon Web Services",
    category: SKILL_CATEGORIES.CLOUD_PLATFORMS,
    aliases: ["amazon web services", "ec2", "s3", "lambda", "cloudformation"],
    relatedSkills: ["Docker", "Kubernetes", "Terraform"],
  },
  azure: {
    normalized: "Microsoft Azure",
    category: SKILL_CATEGORIES.CLOUD_PLATFORMS,
    aliases: ["microsoft azure", "azure cloud"],
    relatedSkills: ["Docker", "Kubernetes", "ARM Templates"],
  },
  gcp: {
    normalized: "Google Cloud Platform",
    category: SKILL_CATEGORIES.CLOUD_PLATFORMS,
    aliases: ["google cloud", "google cloud platform"],
    relatedSkills: ["Docker", "Kubernetes", "Terraform"],
  },

  // Databases
  postgresql: {
    normalized: "PostgreSQL",
    category: SKILL_CATEGORIES.DATABASES,
    aliases: ["postgres", "psql"],
    relatedSkills: ["SQL", "Database Design"],
  },
  mongodb: {
    normalized: "MongoDB",
    category: SKILL_CATEGORIES.DATABASES,
    aliases: ["mongo", "nosql"],
    relatedSkills: ["NoSQL", "Database Design"],
  },

  // Soft Skills
  leadership: {
    normalized: "Leadership",
    category: SKILL_CATEGORIES.SOFT_SKILLS,
    aliases: ["team leadership", "team lead", "leading teams"],
    relatedSkills: ["Communication", "Project Management", "Team Building"],
  },
  communication: {
    normalized: "Communication",
    category: SKILL_CATEGORIES.SOFT_SKILLS,
    aliases: ["verbal communication", "written communication", "presentation"],
    relatedSkills: ["Leadership", "Collaboration", "Public Speaking"],
  },
};

/**
 * Initialize skill categories and skills in the database
 */
export async function initializeSkillHierarchy(): Promise<void> {
  try {
    logger.info("Initializing skill hierarchy...");

    // Create skill categories
    for (const [key, categoryName] of Object.entries(SKILL_CATEGORIES)) {
      await db
        .insert(skillCategories)
        .values({
          name: categoryName,
          level: 0,
          description: `Skills related to ${categoryName.toLowerCase()}`,
        })
        .onConflictDoNothing();
    }

    // Create skills with embeddings
    for (const [key, skillData] of Object.entries(ENHANCED_SKILL_DICTIONARY)) {
      try {
        // Find category ID
        const category = await db
          .select()
          .from(skillCategories)
          .where(eq(skillCategories.name, skillData.category))
          .limit(1);

        if (category.length === 0) {
          logger.warn(`Category not found: ${skillData.category}`);
          continue;
        }

        // Generate embedding for the skill
        const embedding = await generateEmbedding(skillData.normalized);

        // Insert skill (only if not exists to avoid conflicts)
        try {
          await db
            .insert(skillsTable)
            .values({
              name: skillData.normalized,
              normalizedName: skillData.normalized.toLowerCase(),
              categoryId: category[0].id,
              aliases: skillData.aliases,
              embedding: embedding,
              description: `${skillData.normalized} - ${skillData.category}`,
            })
            .onConflictDoNothing();
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          if (
            !errorMessage?.includes("duplicate") &&
            !errorMessage?.includes("unique")
          ) {
            throw error;
          }
        }
      } catch (error) {
        logger.error(`Error creating skill ${skillData.normalized}:`, error);
      }
    }

    logger.info("Skill hierarchy initialization completed");
  } catch (error) {
    logger.error("Error initializing skill hierarchy:", error);
    throw error;
  }
}

/**
 * Enhanced skill normalization using hierarchy and embeddings
 */
export async function normalizeSkillWithHierarchy(skill: string): Promise<{
  normalized: string;
  category?: string;
  confidence: number;
  method: "exact" | "alias" | "fuzzy" | "semantic";
}> {
  const lowerSkill = skill.toLowerCase().trim();

  try {
    // 1. Try exact match
    const exactMatch = await db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.normalizedName, lowerSkill))
      .limit(1);

    if (exactMatch.length > 0) {
      const category = await db
        .select()
        .from(skillCategories)
        .where(eq(skillCategories.id, exactMatch[0].categoryId || 0))
        .limit(1);

      return {
        normalized: exactMatch[0].name,
        category: category[0]?.name,
        confidence: 1.0,
        method: "exact",
      };
    }

    // 2. Try alias matching
    const aliasMatches = await db
      .select()
      .from(skillsTable)
      .where(sql`aliases::text LIKE ${`%"${lowerSkill}"%`}`);

    if (aliasMatches.length > 0) {
      const bestMatch = aliasMatches[0];
      const category = await db
        .select()
        .from(skillCategories)
        .where(eq(skillCategories.id, bestMatch.categoryId || 0))
        .limit(1);

      return {
        normalized: bestMatch.name,
        category: category[0]?.name,
        confidence: 0.95,
        method: "alias",
      };
    }

    // 3. Try fuzzy string matching
    const allSkills = await db.select().from(skillsTable);
    
    // If skills database is empty or has issues, return original skill with appropriate confidence
    if (!allSkills || allSkills.length === 0) {
      logger.warn("Skills database is empty or unavailable, returning original skill without normalization", {
        skill,
        timestamp: new Date().toISOString(),
      });
      return {
        normalized: skill,
        confidence: 0.1, // Very low confidence since no processing occurred
        method: "fuzzy", // Use fuzzy as fallback method for unprocessed skills
      };
    }
    
    const skillNames = allSkills.map((s: any) => s.name);
    const fuzzyMatch = stringSimilarity.findBestMatch(skill, skillNames);

    if (fuzzyMatch.bestMatch.rating > 0.7) {
      const matchedSkill = allSkills.find(
        (s: any) => s.name === fuzzyMatch.bestMatch.target,
      );
      if (matchedSkill) {
        const category = await db
          .select()
          .from(skillCategories)
          .where(eq(skillCategories.id, matchedSkill.categoryId || 0))
          .limit(1);

        return {
          normalized: matchedSkill.name,
          category: category[0]?.name,
          confidence: fuzzyMatch.bestMatch.rating,
          method: "fuzzy",
        };
      }
    }

    // 4. Try semantic similarity using embeddings
    const queryEmbedding = await generateEmbedding(skill);
    let bestSemanticMatch = null;
    let bestSimilarity = 0;

    for (const dbSkill of allSkills) {
      if (dbSkill.embedding && Array.isArray(dbSkill.embedding)) {
        const similarity = cosineSimilarity(queryEmbedding, dbSkill.embedding);
        if (similarity > bestSimilarity && similarity > 0.6) {
          bestSimilarity = similarity;
          bestSemanticMatch = dbSkill;
        }
      }
    }

    if (bestSemanticMatch) {
      const category = await db
        .select()
        .from(skillCategories)
        .where(eq(skillCategories.id, bestSemanticMatch.categoryId || 0))
        .limit(1);

      return {
        normalized: bestSemanticMatch.name,
        category: category[0]?.name,
        confidence: bestSimilarity,
        method: "semantic",
      };
    }

    // 5. Final fallback - no matches found at all
    logger.debug("No skill matches found, returning original skill", {
      skill,
      timestamp: new Date().toISOString(),
    });
    return {
      normalized: skill,
      confidence: 0.2, // Low confidence for unmatched skills
      method: "fuzzy", // Use fuzzy as fallback method for unmatched skills
    };
  } catch (error) {
    logger.error("Error in skill normalization:", {
      error: error instanceof Error ? error.message : "Unknown error",
      skill,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      normalized: skill,
      confidence: 0.05, // Very low confidence for error cases
      method: "fuzzy", // Use fuzzy as fallback method for error cases
    };
  }
}

/**
 * Get skills by category
 */
export async function getSkillsByCategory(
  categoryName: string,
): Promise<Skill[]> {
  try {
    const category = await db
      .select()
      .from(skillCategories)
      .where(eq(skillCategories.name, categoryName))
      .limit(1);

    if (category.length === 0) {
      return [];
    }

    return await db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.categoryId, category[0].id));
  } catch (error) {
    logger.error("Error getting skills by category:", error);
    return [];
  }
}

/**
 * Find related skills using embeddings
 */
export async function findRelatedSkills(
  skill: string,
  limit: number = 5,
): Promise<
  Array<{
    skill: string;
    similarity: number;
    category?: string;
  }>
> {
  try {
    const queryEmbedding = await generateEmbedding(skill);
    const allSkills = await db.select().from(skillsTable);

    const similarities: Array<{
      skill: string;
      similarity: number;
      category?: string;
    }> = [];

    for (const dbSkill of allSkills) {
      if (
        dbSkill.embedding &&
        Array.isArray(dbSkill.embedding) &&
        dbSkill.name !== skill
      ) {
        const similarity = cosineSimilarity(queryEmbedding, dbSkill.embedding);
        if (similarity > 0.5) {
          const category = await db
            .select()
            .from(skillCategories)
            .where(eq(skillCategories.id, dbSkill.categoryId || 0))
            .limit(1);

          similarities.push({
            skill: dbSkill.name,
            similarity: similarity,
            category: category[0]?.name,
          });
        }
      }
    }

    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  } catch (error) {
    logger.error("Error finding related skills:", error);
    return [];
  }
}

/**
 * Enhanced skill extraction using ESCO taxonomy
 * Combines traditional skill matching with ESCO skill extraction
 */
export async function extractSkillsWithESCO(text: string): Promise<{
  skills: string[];
  escoSkills: ESCOSkill[];
  pharmaRelated: boolean;
  categories: string[];
}> {
  try {
    logger.info('Starting enhanced skill extraction with ESCO', {
      textLength: text.length
    });

    // Run ESCO extraction
    const escoResult = await escoExtractor.extractSkills(text);
    const pharmaRelated = await escoExtractor.isPharmaRelated(text);

    // Extract skills from ESCO results
    const escoSkills = escoResult.skills || [];
    const escoSkillNames = escoSkills.map(skill => skill.skill);

    // Get traditional skills using existing normalization
    const traditionalSkills: string[] = [];
    
    // Try to normalize each ESCO skill through our existing system
    for (const escoSkillName of escoSkillNames) {
      try {
        const normalized = await normalizeSkillWithHierarchy(escoSkillName);
        if (normalized.confidence > 0.5) {
          traditionalSkills.push(normalized.normalized);
        } else {
          // Add ESCO skill directly if not found in traditional system
          traditionalSkills.push(escoSkillName);
        }
      } catch (error) {
        // If database access fails (memory storage mode), add ESCO skill directly
        logger.debug('Database normalization failed, using ESCO skill directly', {
          skill: escoSkillName,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        traditionalSkills.push(escoSkillName);
      }
    }

    // Combine and deduplicate skills
    const allSkills = [...new Set([...traditionalSkills, ...escoSkillNames])];
    
    // Get unique categories
    const categories = [...new Set([
      ...escoSkills.map(skill => skill.category),
      ...escoResult.domains
    ])];

    logger.info('Enhanced skill extraction completed', {
      totalSkills: allSkills.length,
      escoSkills: escoSkills.length,
      traditionalSkills: traditionalSkills.length,
      pharmaRelated,
      categories: categories.length
    });

    return {
      skills: allSkills,
      escoSkills,
      pharmaRelated,
      categories
    };
  } catch (error) {
    logger.error('Enhanced skill extraction failed', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    
    // Fallback to empty result
    return {
      skills: [],
      escoSkills: [],
      pharmaRelated: false,
      categories: []
    };
  }
}

/**
 * Get enhanced skills for resume or job analysis
 * This replaces the traditional skill extraction in our ML pipeline
 */
export async function getEnhancedSkills(text: string, existingSkills: string[] = []): Promise<string[]> {
  try {
    const enhanced = await extractSkillsWithESCO(text);
    
    // Combine ESCO skills with existing skills
    const combinedSkills = [...new Set([...existingSkills, ...enhanced.skills])];
    
    logger.info('Enhanced skills generated', {
      originalSkills: existingSkills.length,
      escoSkills: enhanced.escoSkills.length,
      finalSkills: combinedSkills.length,
      pharmaContent: enhanced.pharmaRelated
    });
    
    return combinedSkills;
  } catch (error) {
    logger.error('Failed to get enhanced skills', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return existingSkills;
  }
}
