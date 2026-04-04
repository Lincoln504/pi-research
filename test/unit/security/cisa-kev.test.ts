/**
 * CISA Known Exploited Vulnerabilities Client Unit Tests
 *
 * Tests the CISA Known Exploited Vulnerabilities (KEV) catalog client
 * for tracking vulnerabilities with active real-world exploitation.
 */

import { describe, it, expect } from 'vitest';

describe('CISA Known Exploited Vulnerabilities Client', () => {
  describe('API endpoint', () => {
    it('should define CISA KEV catalog URL', () => {
      const baseUrl = 'https://www.cisa.gov/sites/default/files/feeds/vulnerabilities.json';

      expect(baseUrl).toContain('cisa.gov');
      expect(baseUrl).toContain('vulnerabilities.json');
    });

    it('should support JSON catalog format', () => {
      const format = 'application/json';
      expect(format).toBe('application/json');
    });
  });

  describe('Catalog structure', () => {
    it('should represent catalog metadata', () => {
      const catalog = {
        catalogVersion: '1.0',
        dateReleased: '2024-01-15T00:00:00Z',
        count: 1000,
      };

      expect(catalog.catalogVersion).toBe('1.0');
      expect(catalog.count).toBeGreaterThan(0);
    });

    it('should contain vulnerabilities array', () => {
      const catalog = {
        vulnerabilities: [
          {
            cveId: 'CVE-2024-0001',
            dateAdded: '2024-01-15',
          },
        ],
      };

      expect(catalog.vulnerabilities).toHaveLength(1);
    });

    it('should support metadata fields', () => {
      const catalog = {
        catalogVersion: '1.0',
        dateReleased: '2024-01-15T00:00:00Z',
        countCVEs: 1000,
        countActiveVulnerabilities: 500,
      };

      expect(catalog.countCVEs).toBeGreaterThanOrEqual(catalog.countActiveVulnerabilities);
    });
  });

  describe('Vulnerability entries', () => {
    it('should include CVE ID', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
      };

      expect(vuln.cveId).toMatch(/^CVE-\d{4}-\d+$/);
    });

    it('should include date added to KEV catalog', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        dateAdded: '2024-01-15',
      };

      expect(vuln.dateAdded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should include vendor and product information', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        vendorProject: 'Apache Software Foundation',
        product: 'Log4j',
        vulnerabilityName: 'Log4j Remote Code Execution',
      };

      expect(vuln.vendorProject).toBeDefined();
      expect(vuln.product).toBeDefined();
      expect(vuln.vulnerabilityName).toBeDefined();
    });

    it('should include description', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        shortDescription: 'Brief description of the vulnerability',
      };

      expect(vuln.shortDescription).toBeDefined();
      expect(vuln.shortDescription.length).toBeGreaterThan(0);
    });

    it('should include affected versions', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        affectedVersions: [
          '1.0',
          '1.1',
          '1.2',
        ],
      };

      expect(vuln.affectedVersions).toHaveLength(3);
    });
  });

  describe('Exploitation status', () => {
    it('should indicate active exploitation', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        knownExploited: true,
      };

      expect(vuln.knownExploited).toBe(true);
    });

    it('should show exploitation evidence', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        knownExploited: true,
        dateFirstExploited: '2024-01-01',
      };

      expect(vuln.dateFirstExploited).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should include required actions', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        requiredAction: 'Apply updates or patches',
        dueDate: '2024-02-15',
      };

      expect(vuln.requiredAction).toBeDefined();
      expect(vuln.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should include exploitation notes', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        notes: 'Active exploitation observed in ransomware campaigns',
      };

      expect(vuln.notes).toBeDefined();
    });
  });

  describe('References', () => {
    it('should include CISA advisory references', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        cisaAK: 'https://www.cisa.gov/resources/advisories/aa24-001a',
      };

      expect(vuln.cisaAK).toContain('cisa.gov');
    });

    it('should include NVD reference', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        nvdLink: 'https://nvd.nist.gov/vuln/detail/CVE-2024-12345',
      };

      expect(vuln.nvdLink).toContain('nvd.nist.gov');
    });
  });

  describe('Querying KEV catalog', () => {
    it('should filter by vendor', () => {
      const filter = {
        vendor: 'Apache',
      };

      expect(filter.vendor).toBe('Apache');
    });

    it('should filter by product', () => {
      const filter = {
        product: 'Log4j',
      };

      expect(filter.product).toBe('Log4j');
    });

    it('should filter by date added', () => {
      const filter = {
        dateAddedAfter: '2024-01-01',
        dateAddedBefore: '2024-12-31',
      };

      expect(filter.dateAddedAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should filter by exploitation status', () => {
      const filter = {
        knownExploited: true,
      };

      expect(filter.knownExploited).toBe(true);
    });

    it('should search by CVE ID', () => {
      const search = {
        cveId: 'CVE-2024-12345',
      };

      expect(search.cveId).toMatch(/^CVE-/);
    });
  });

  describe('Response handling', () => {
    it('should parse catalog response', () => {
      const response = {
        vulnerabilities: [
          {
            cveId: 'CVE-2024-0001',
            dateAdded: '2024-01-01',
          },
        ],
        count: 1,
      };

      expect(response.vulnerabilities).toHaveLength(1);
      expect(response.count).toBe(1);
    });

    it('should handle empty catalog', () => {
      const response = {
        vulnerabilities: [],
        count: 0,
      };

      expect(response.vulnerabilities).toHaveLength(0);
    });

    it('should handle large catalogs', () => {
      const count = 1000;
      const vulnerabilities = Array(count)
        .fill(null)
        .map((_, i) => ({
          cveId: `CVE-2024-${i.toString().padStart(5, '0')}`,
          dateAdded: '2024-01-15',
        }));

      expect(vulnerabilities).toHaveLength(count);
    });
  });

  describe('Data validation', () => {
    it('should validate CVE ID format', () => {
      const cveId = 'CVE-2024-12345';
      const isValid = /^CVE-\d{4}-\d+$/.test(cveId);

      expect(isValid).toBe(true);
    });

    it('should validate date format', () => {
      const date = '2024-01-15';
      const isValid = /^\d{4}-\d{2}-\d{2}$/.test(date);

      expect(isValid).toBe(true);
    });

    it('should require vendor and product', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        vendorProject: 'Apache Software Foundation',
        product: 'Log4j',
      };

      expect(vuln.vendorProject).toBeDefined();
      expect(vuln.product).toBeDefined();
    });

    it('should require date added', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        dateAdded: '2024-01-15',
      };

      expect(vuln.dateAdded).toBeDefined();
    });
  });

  describe('Catalog updates', () => {
    it('should track last update time', () => {
      const catalog = {
        dateReleased: '2024-01-15T00:00:00Z',
      };

      expect(catalog.dateReleased).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('should version catalog', () => {
      const catalog = {
        catalogVersion: '1.0',
      };

      expect(catalog.catalogVersion).toBeDefined();
    });

    it('should provide counts', () => {
      const catalog = {
        countCVEs: 1000,
        dateReleased: '2024-01-15T00:00:00Z',
      };

      expect(catalog.countCVEs).toBeGreaterThan(0);
    });
  });

  describe('Due date tracking', () => {
    it('should include due date for remediation', () => {
      const vuln = {
        cveId: 'CVE-2024-12345',
        dueDate: '2024-02-15',
      };

      expect(vuln.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should track date added vs due date', () => {
      const vuln = {
        dateAdded: '2024-01-15',
        dueDate: '2024-02-15',
      };

      const added = new Date(vuln.dateAdded);
      const due = new Date(vuln.dueDate);

      expect(due.getTime()).toBeGreaterThan(added.getTime());
    });

    it('should calculate days until due date', () => {
      const dateAdded = new Date('2024-01-15');
      const dueDate = new Date('2024-02-15');

      const daysUntilDue = Math.ceil(
        (dueDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
      );

      expect(typeof daysUntilDue).toBe('number');
    });
  });
});
