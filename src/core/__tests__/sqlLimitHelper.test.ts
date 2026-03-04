import { applyRowLimit } from '../sqlLimitHelper';

describe('sqlLimitHelper', () => {
  describe('applyRowLimit', () => {
    it('should return original SQL when maxRows is 0', () => {
      const sql = 'SELECT * FROM users';
      const result = applyRowLimit(sql, 0);

      expect(result.sql).toBe(sql);
      expect(result.clamped).toBe(false);
      expect(result.effectiveLimit).toBe(0);
    });

    it('should apply limit to SELECT statements', () => {
      const sql = 'SELECT * FROM users';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
      expect(result.clamped).toBe(false);
      expect(result.effectiveLimit).toBe(100);
    });

    it('should not apply limit to CREATE statements', () => {
      const sql = 'CREATE TABLE users (id INT, name TEXT)';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe(sql);
      expect(result.clamped).toBe(false);
      expect(result.effectiveLimit).toBe(0);
    });

    it('should not apply limit to INSERT statements', () => {
      const sql = 'INSERT INTO users (id, name) VALUES (1, \'John\')';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe(sql);
      expect(result.clamped).toBe(false);
    });

    it('should not apply limit to UPDATE statements', () => {
      const sql = 'UPDATE users SET name = \'Jane\' WHERE id = 1';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe(sql);
      expect(result.clamped).toBe(false);
    });

    it('should not apply limit to DELETE statements', () => {
      const sql = 'DELETE FROM users WHERE id = 1';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe(sql);
      expect(result.clamped).toBe(false);
    });

    it('should respect existing LIMIT when smaller than maxRows', () => {
      const sql = 'SELECT * FROM users LIMIT 50';
      const result = applyRowLimit(sql, 100);

      expect(result.clamped).toBe(false);
      expect(result.effectiveLimit).toBe(50);
    });

    it('should clamp existing LIMIT when larger than maxRows', () => {
      const sql = 'SELECT * FROM users LIMIT 200';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
      expect(result.clamped).toBe(true);
      expect(result.effectiveLimit).toBe(100);
    });

    it('should handle WITH (CTE) statements by appending LIMIT', () => {
      const sql = 'WITH temp AS (SELECT * FROM users) SELECT * FROM temp';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe('WITH temp AS (SELECT * FROM users) SELECT * FROM temp LIMIT 100');
      expect(result.sql).not.toContain('dp_limit_sub');
      expect(result.effectiveLimit).toBe(100);
    });

    it('should handle CTE with multiple CTEs', () => {
      const sql = 'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON true';
      const result = applyRowLimit(sql, 50);

      expect(result.sql).toBe('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON true LIMIT 50');
      expect(result.sql).not.toContain('dp_limit_sub');
    });

    it('should handle CTE with existing LIMIT smaller than maxRows', () => {
      const sql = 'WITH temp AS (SELECT * FROM users) SELECT * FROM temp LIMIT 10';
      const result = applyRowLimit(sql, 100);

      expect(result.effectiveLimit).toBe(10);
      expect(result.clamped).toBe(false);
    });

    it('should clamp CTE with existing LIMIT larger than maxRows', () => {
      const sql = 'WITH temp AS (SELECT * FROM users) SELECT * FROM temp LIMIT 500';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
      expect(result.sql).not.toContain('dp_limit_sub');
      expect(result.clamped).toBe(true);
    });

    it('should handle CTE with trailing semicolon', () => {
      const sql = 'WITH temp AS (SELECT * FROM users) SELECT * FROM temp;';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe('WITH temp AS (SELECT * FROM users) SELECT * FROM temp LIMIT 100');
    });

    it('should handle lowercase CTE', () => {
      const sql = 'with temp as (select * from users) select * from temp';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe('with temp as (select * from users) select * from temp LIMIT 100');
      expect(result.sql).not.toContain('dp_limit_sub');
    });

    it('should handle VALUES statements', () => {
      const sql = 'VALUES (1, \'a\'), (2, \'b\')';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
    });

    it('should handle SHOW statements', () => {
      const sql = 'SHOW TABLES';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
    });

    it('should handle DESCRIBE statements', () => {
      const sql = 'DESCRIBE users';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
    });

    it('should handle EXPLAIN statements', () => {
      const sql = 'EXPLAIN SELECT * FROM users';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
    });

    it('should strip trailing semicolons before wrapping', () => {
      const sql = 'SELECT * FROM users;';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).not.toContain(';)');
      expect(result.sql).toContain('FROM (SELECT * FROM users) AS dp_limit_sub LIMIT 100');
    });

    it('should strip trailing comments with semicolons', () => {
      const sql = 'SELECT * FROM users; -- comment';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).not.toContain('comment');
      expect(result.sql).toContain('LIMIT 100');
    });

    it('should strip block comments at end', () => {
      const sql = 'SELECT * FROM users; /* comment */';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).not.toContain('comment');
    });

    it('should handle LIMIT with OFFSET', () => {
      const sql = 'SELECT * FROM users LIMIT 50 OFFSET 10';
      const result = applyRowLimit(sql, 100);

      expect(result.effectiveLimit).toBe(50);
      expect(result.clamped).toBe(false);
    });

    it('should wrap SQL in subquery correctly', () => {
      const sql = 'SELECT id, name FROM users WHERE active = true';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toBe('SELECT * FROM (SELECT id, name FROM users WHERE active = true) AS dp_limit_sub LIMIT 100');
    });

    it('should handle multiline SQL', () => {
      const sql = `
        SELECT
          id,
          name
        FROM users
        WHERE active = true
      `;
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
      expect(result.effectiveLimit).toBe(100);
    });

    it('should handle case-insensitive keywords', () => {
      const sql = 'select * from users';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
    });

    it('should handle mixed case keywords', () => {
      const sql = 'SeLeCt * FrOm users';
      const result = applyRowLimit(sql, 100);

      expect(result.sql).toContain('LIMIT 100');
    });
  });
});
