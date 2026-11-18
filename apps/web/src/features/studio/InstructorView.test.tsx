import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import {
  InstructorView,
  instructorClassStorageKey,
  instructorDefaultStudentCount
} from './InstructorView.js';

beforeEach(() => {
  window.localStorage.clear();
});

function renderInstructor(courseService?: Parameters<typeof InstructorView>[0]['courseService']) {
  return render(
    <LanguageProvider initialPreference="zh-CN">
      <InstructorView courseService={courseService} />
    </LanguageProvider>
  );
}

describe('InstructorView', () => {
  it('starts with a twelve-student roster and marks everyone present', async () => {
    renderInstructor();

    expect(screen.getAllByLabelText(/学生 \d+ 姓名/)).toHaveLength(instructorDefaultStudentCount);
    fireEvent.change(screen.getByLabelText('学生 1 状态'), { target: { value: 'absent' } });
    expect(screen.getByText('11 出席')).toBeInTheDocument();
    expect(screen.getByText('1 缺席')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '全部出席' }));
    expect(screen.getByText('12 出席')).toBeInTheDocument();
    expect(screen.getByText('0 缺席')).toBeInTheDocument();

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(instructorClassStorageKey) ?? '{}');
      expect(stored.students).toHaveLength(instructorDefaultStudentCount);
      expect(stored.students.every((student: { status: string }) => student.status === 'present')).toBe(true);
    });
  });

  it('adds and removes students and persists the roster locally', async () => {
    renderInstructor();

    fireEvent.click(screen.getByRole('button', { name: '添加学生' }));
    expect(screen.getAllByLabelText(/学生 \d+ 姓名/)).toHaveLength(instructorDefaultStudentCount + 1);
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(instructorClassStorageKey) ?? '{}');
      expect(stored.students).toHaveLength(instructorDefaultStudentCount + 1);
    });

    fireEvent.click(screen.getByRole('button', { name: '移除学生 1' }));
    expect(screen.getAllByLabelText(/学生 \d+ 姓名/)).toHaveLength(instructorDefaultStudentCount);
  });

  it('starts and pauses the session timer', () => {
    renderInstructor();

    fireEvent.click(screen.getByRole('button', { name: '开始' }));
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(screen.getByRole('button', { name: '开始' })).toBeInTheDocument();
  });

  it('loads published courses and modules for the class', async () => {
    const listCourseVideoCourses = vi.fn(async () => ({
      courses: [{
        id: 'course_1',
        slug: 'understanding-behavior',
        title: 'Understanding Behavior',
        moduleCount: 2
      }]
    }));
    const getCourseVideoCourse = vi.fn(async () => ({
      courseId: 'course_1',
      versionId: 'version_1',
      slug: 'understanding-behavior',
      title: 'Understanding Behavior',
      modules: [
        { moduleKey: 'm01', title: 'Functions and Causes', order: 1 },
        { moduleKey: 'm02', title: 'Reinforcement', order: 2 }
      ]
    }));
    renderInstructor({ listCourseVideoCourses, getCourseVideoCourse });

    expect(await screen.findByRole('option', { name: /Understanding Behavior/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: 'understanding-behavior' } });
    expect(await screen.findByRole('option', { name: 'Functions and Causes' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('当前模块'), { target: { value: 'm02' } });

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(instructorClassStorageKey) ?? '{}');
      expect(stored).toMatchObject({
        courseSlug: 'understanding-behavior',
        moduleKey: 'm02',
        moduleTitle: 'Reinforcement'
      });
    });
  });

  it('creates a fresh class on demand', async () => {
    renderInstructor();
    fireEvent.change(screen.getByLabelText('课堂名称'), { target: { value: 'Cohort A' } });
    expect(screen.getByLabelText('课堂名称')).toHaveValue('Cohort A');

    fireEvent.click(screen.getByRole('button', { name: '新建课堂' }));
    expect(screen.getByLabelText('课堂名称')).toHaveValue('');
    expect(screen.getAllByLabelText(/学生 \d+ 姓名/)).toHaveLength(instructorDefaultStudentCount);
  });
});
