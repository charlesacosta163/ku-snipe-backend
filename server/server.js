import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import 'dotenv/config';
import dotenv from 'dotenv'

dotenv.config()

const app = express();
const port = process.env.PORT || 3002;
const URL = process.env.SCHOOL_URL
// Middleware
app.use(cors());
app.use(express.json());

let browser;

(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
})();

// Course search endpoint
app.post('/api/courses', async (req, res) => {
  let page
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({
        error: "Invalid request body",
        message: "Course name is required"
      });
    }
    
   page = await browser.newPage();

    // Navigate to course search
    try {
      await page.goto(
        `${URL}?keyword=${name}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 30000
        }
      );
    } catch (error) {
      return res.status(503).json({
        error: "Navigation failed",
        message: "Failed to access course search page"
      });
    }

    // Wait for initial content
    try {
      await page.waitForSelector('ul[data-bind="foreach: SubjectsPartialList"]', { timeout: 10000 });
      await page.waitForSelector("ul#course-resultul", { timeout: 10000 });
    } catch (error) {
      return res.status(404).json({
        error: "Course not found",
        message: `No results found for course: ${name}`
      });
    }

    // Check if course exists and is rendered
    const courseExists = await page.evaluate(() => {
      const courses = document.querySelectorAll("#course-resultul > li");
      return courses.length > 0;
    });

    if (!courseExists) {
      return res.status(404).json({
        error: "Course not found",
        message: `No results found for course: ${name}`
      });
    }

    // Ensure at least one course is fully rendered
    await page.waitForFunction(
      () => {
        const courses = document.querySelectorAll(
          "#course-resultul > li:nth-child(1) span[data-bind]"
        );
        const coursesDescription = document.querySelectorAll(
          "#course-resultul > li:nth-child(1) .search-coursedescription"
        );
        return courses.length > 0 && courses[0]?.textContent?.trim()?.length > 0;
      },
      { timeout: 60000 }
    );

    // Extract course details
    const courseDetails = await page.evaluate((searchQuery) => {
      const courseElement = document.querySelector("#course-resultul > li:nth-child(1) span[data-bind]");
      const name = courseElement?.textContent?.trim();
      const description = document.querySelector("#course-resultul > li:nth-child(1) .search-coursedescription")?.textContent?.trim();

      // Extract course code from the full course name
      const courseCodeMatch = name?.match(/([A-Z]+)[\s\*](\d+)/i);
      if (!courseCodeMatch) return null;

      const [_, prefix, number] = courseCodeMatch;

      // Clean up search query to match format
      const cleanSearchQuery = searchQuery.replace(/\+/g, '').toUpperCase();
      const searchPrefix = cleanSearchQuery.match(/([A-Z]+)/i)?.[1];
      const searchNumber = cleanSearchQuery.match(/(\d+)/)?.[1];

      // Check if both the prefix and number match
      if (prefix?.toUpperCase() !== searchPrefix || number !== searchNumber) {
        return null;
      }

      return { name, description };
    }, name);

    if (!courseDetails) {
      return res.status(404).json({
        error: "Course not found",
        message: `No exact match found for course: ${name}`
      });
    }

    // Try to wait for and interact with the sections button
    try {
      await page.waitForSelector(
        "#course-resultul > li:nth-child(1) button.esg-collapsible-group__toggle",
        { timeout: 5000 }
      );

      const buttonExists = await page.evaluate(() => {
        const button = document.querySelector("#course-resultul > li:nth-child(1) button.esg-collapsible-group__toggle");
        return !!button;
      });

      if (!buttonExists) {
        return res.json({
          course: courseDetails,
          sortedCoursesAndTerms: []
        });
      }

      // Click the collapsible group toggle
      await page.$eval(
        "#course-resultul > li:nth-child(1) button.esg-collapsible-group__toggle",
        (button) => button.click()
      );
    } catch (error) {
      return res.json({
        course: courseDetails,
        sortedCoursesAndTerms: []
      });
    }

    // Wait for the TermsAndSections container
    await page.waitForSelector(
      "#course-resultul > li:nth-child(1) div[data-bind='foreach: TermsAndSections']",
      { timeout: 60000 }
    );

    // Wait for term headers
    await page.waitForFunction(
      () => {
        const terms = document.querySelectorAll(
          "#course-resultul > li:nth-child(1) div[data-bind='foreach: TermsAndSections'] > h4"
        );
        return terms.length > 0 && Array.from(terms).some(h4 => h4.textContent.trim().length > 0);
      },
      { timeout: 60000 }
    );

     // Extract section data
    const extractedData = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll(
          "#course-resultul > li:nth-child(1) div[data-bind='foreach: TermsAndSections']"
        )
      ).flatMap((termDiv) => {
        const sections = Array.from(
          termDiv.querySelectorAll('ul[data-bind="foreach: Sections"] li')
        ).map((li) => {
          const sectionName = li.querySelector("a.search-sectiondetailslink")?.textContent?.trim() || "No Section name provided";
          const professor = li.querySelector('span[title="Show Office Hours"]')?.textContent?.trim();
          const seats = li.querySelector("span.search-seatsavailabletext")?.textContent?.trim() || "No Seat Data";
          const allTimes = Array.from(
            li.querySelectorAll("span.search-meetingtimestext")
          )
            .map((span) => span.textContent?.trim())
            .filter((text) =>
              text?.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/)
            );

          const dates = allTimes.length > 0 ? allTimes[0] : "No Date Info";
          return { sectionName, professor, seats, dates };
        });

        return sections;
      });
    });

    // Modify the sortedCoursesAndTerms to only include Fall and Spring terms
    let sortedCoursesAndTerms = [
      { term: "Fall 2024", sections: [] },
      { term: "Spring 2025", sections: [] },
      { term: "Fall 2025", sections: [] },
    ];

    // Term constraints - only include Fall and Spring
    const termConstraints = [
      {
        term: "Fall 2024",
        constraint: {
          start: new Date(2024, 8, 1),
          end: new Date(2024, 11, 20),
        },
      },
      {
        term: "Spring 2025",
        constraint: {
          start: new Date(2025, 0, 13),
          end: new Date(2025, 4, 7),
        },
      },
      {
        term: "Fall 2025",
        constraint: {
          start: new Date(2025, 8, 1),
          end: new Date(2025, 11, 20),
        },
      },
    ];

    // Sort courses into terms with robust null checking
    extractedData.forEach((course) => {
      if (!course || !course.dates || typeof course.dates !== 'string' || course.dates === "No Date Info") {
        return; // Skip courses with invalid dates
      }
      
      try {
        // Check if dates string has the expected format
        if (!course.dates.includes(" - ")) return;
        
        const [start, end] = course.dates.split(" - ");
        if (!start || !end) return;
        
        // Check if date parts are valid
        const startParts = start.split("/");
        const endParts = end.split("/");
        if (startParts.length !== 3 || endParts.length !== 3) return;
        
        // Extract and normalize start date with null checking
        const [startMonth, startDay, startYear] = startParts.map(part => {
          const num = Number(part);
          return isNaN(num) ? 0 : num;
        });
        
        // Skip if any date part is invalid
        if (startMonth === 0 || startDay === 0 || startYear === 0) return;
        
        const formattedStartYear = startYear < 100 ? 2000 + startYear : startYear;
        const startDateFormat = new Date(formattedStartYear, startMonth - 1, startDay);
        
        // Extract and normalize end date with null checking
        const [endMonth, endDay, endYear] = endParts.map(part => {
          const num = Number(part);
          return isNaN(num) ? 0 : num;
        });
        
        // Skip if any date part is invalid
        if (endMonth === 0 || endDay === 0 || endYear === 0) return;
        
        const formattedEndYear = endYear < 100 ? 2000 + endYear : endYear;
        const endDateFormat = new Date(formattedEndYear, endMonth - 1, endDay);
        
        // Validate dates are valid Date objects
        if (isNaN(startDateFormat.getTime()) || isNaN(endDateFormat.getTime())) return;
        
        termConstraints.forEach((term, index) => {
          if (startDateFormat >= term.constraint.start && endDateFormat <= term.constraint.end) {
            sortedCoursesAndTerms[index].sections.push({
              name: course.sectionName || "Unknown Section",
              professor: course.professor || "No Professor",
              seats: course.seats || "No Seat Data",
              startDate: startDateFormat,
              endDate: endDateFormat,
            });
          }
        });
      } catch (dateError) {
        console.error("Error processing course dates:", dateError);
        // Continue to next course without adding this one
      }
    });

    // Filter out terms with no sections
    sortedCoursesAndTerms = sortedCoursesAndTerms.filter(e => e.sections.length > 0);

    res.json({
      course: courseDetails,
      sortedCoursesAndTerms
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({
      error: "Internal server error",
      message: "An unexpected error occurred while processing your request"
    });
  } finally {
    if (browser) {
      await page.close();
    }
  }
});

// Close the browser when the server shuts down
process.on('exit', async () => {
  if (browser) {
    await browser.close();
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
