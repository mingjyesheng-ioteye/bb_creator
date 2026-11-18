import type {
  CourseVideoCourseDetail,
  CourseVideoCourseSummary
} from '@opencreator/protocol';
import { CalendarDays, Clock, Pause, Play, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import type { CreatorWebService } from '../../services/creator-service.js';
import './studio.css';

export type InstructorCourseService = Pick<
  CreatorWebService,
  'listCourseVideoCourses' | 'getCourseVideoCourse'
>;

export type InstructorStudentStatus = 'present' | 'absent' | 'late';

export type InstructorStudent = {
  id: string;
  name: string;
  email: string;
  status: InstructorStudentStatus;
  note: string;
};

export type InstructorClass = {
  id: string;
  name: string;
  date: string;
  courseSlug: string;
  courseTitle: string;
  moduleKey: string;
  moduleTitle: string;
  students: InstructorStudent[];
  notes: string;
  elapsedSeconds: number;
  runningSince: number | null;
  updatedAt: string;
};

export const instructorClassStorageKey = 'opencreator.studio.instructor.v1';
export const instructorDefaultStudentCount = 12;
export const instructorMaxStudentCount = 20;

export function InstructorView(props: {
  courseService?: InstructorCourseService | null;
}) {
  const l = useLocalizedCopy();
  const [klass, setKlass] = useState<InstructorClass>(() => loadInstructorClass());
  const [courses, setCourses] = useState<CourseVideoCourseSummary[]>([]);
  const [courseDetail, setCourseDetail] = useState<CourseVideoCourseDetail>();
  const [catalogError, setCatalogError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      window.localStorage.setItem(instructorClassStorageKey, JSON.stringify(klass));
    } catch {
      // A blocked storage quota must not break the console.
    }
  }, [klass]);

  useEffect(() => {
    if (klass.runningSince === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [klass.runningSince]);

  const listCourses = props.courseService?.listCourseVideoCourses;
  const getCourse = props.courseService?.getCourseVideoCourse;

  useEffect(() => {
    if (listCourses === undefined) return undefined;
    let active = true;
    setCatalogError('');
    void listCourses()
      .then(result => { if (active) setCourses(result.courses); })
      .catch(() => {
        if (active) setCatalogError(l('无法读取 bb_exam 课程，可手动填写课程名称。', 'Could not load bb_exam courses. Enter the course name manually.'));
      });
    return () => { active = false; };
  }, [listCourses, l]);

  useEffect(() => {
    if (getCourse === undefined || klass.courseSlug.trim().length === 0) {
      setCourseDetail(undefined);
      return undefined;
    }
    let active = true;
    void getCourse(klass.courseSlug.trim())
      .then(detail => { if (active) setCourseDetail(detail); })
      .catch(() => { if (active) setCourseDetail(undefined); });
    return () => { active = false; };
  }, [getCourse, klass.courseSlug]);

  const elapsedSeconds = klass.elapsedSeconds + (
    klass.runningSince === null ? 0 : Math.max(0, (now - klass.runningSince) / 1_000)
  );
  const counts = useMemo(() => ({
    present: klass.students.filter(student => student.status === 'present').length,
    absent: klass.students.filter(student => student.status === 'absent').length,
    late: klass.students.filter(student => student.status === 'late').length
  }), [klass.students]);

  function patchClass(patch: Partial<InstructorClass>) {
    setKlass(current => ({ ...current, ...patch, updatedAt: new Date().toISOString() }));
  }

  function selectCourse(slug: string) {
    const course = courses.find(candidate => candidate.slug === slug);
    patchClass({
      courseSlug: slug,
      courseTitle: course?.title ?? '',
      moduleKey: '',
      moduleTitle: ''
    });
  }

  function selectModule(moduleKey: string) {
    const module = courseDetail?.modules.find(candidate => candidate.moduleKey === moduleKey);
    patchClass({ moduleKey, moduleTitle: module?.title ?? '' });
  }

  function updateStudent(id: string, patch: Partial<InstructorStudent>) {
    setKlass(current => ({
      ...current,
      updatedAt: new Date().toISOString(),
      students: current.students.map(student => student.id === id ? { ...student, ...patch } : student)
    }));
  }

  function addStudent() {
    setKlass(current => {
      if (current.students.length >= instructorMaxStudentCount) return current;
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        students: [
          ...current.students,
          createStudent(current.students.length + 1)
        ]
      };
    });
  }

  function removeStudent(id: string) {
    setKlass(current => ({
      ...current,
      updatedAt: new Date().toISOString(),
      students: current.students.filter(student => student.id !== id)
    }));
  }

  function markAllPresent() {
    setKlass(current => ({
      ...current,
      updatedAt: new Date().toISOString(),
      students: current.students.map(student => ({ ...student, status: 'present' }))
    }));
  }

  function startSession() {
    if (klass.runningSince !== null) return;
    setKlass(current => ({
      ...current,
      runningSince: Date.now(),
      updatedAt: new Date().toISOString()
    }));
  }

  function pauseSession() {
    if (klass.runningSince === null) return;
    const pausedAt = Date.now();
    setKlass(current => ({
      ...current,
      elapsedSeconds: current.elapsedSeconds + Math.max(0, (pausedAt - current.runningSince!) / 1_000),
      runningSince: null,
      updatedAt: new Date().toISOString()
    }));
  }

  function resetSession() {
    setKlass(current => ({
      ...current,
      elapsedSeconds: 0,
      runningSince: null,
      updatedAt: new Date().toISOString()
    }));
  }

  function newClass() {
    setKlass(createInstructorClass());
  }

  const running = klass.runningSince !== null;
  return (
    <div className="instructor">
      <header className="instructor__header">
        <div>
          <h2>{l('课堂控制台', 'Instructor Studio')}</h2>
          <p className="studio__muted">
            {l('面向约 12 人的小班课，管理出勤、课堂进度与计时。', 'Run a small instructor-led class with attendance, progress and timing.')}
          </p>
        </div>
        <button type="button" className="studio__button" onClick={newClass}>
          <RotateCcw size={14} /> {l('新建课堂', 'New class')}
        </button>
      </header>

      <div className="instructor__grid">
        <section className="instructor__panel">
          <h3><CalendarDays size={15} /> {l('课堂信息', 'Class details')}</h3>
          <div className="instructor__fields">
            <label className="studio__field">
              <span>{l('课堂名称', 'Class name')}</span>
              <input
                value={klass.name}
                maxLength={120}
                onChange={event => patchClass({ name: event.target.value })}
                placeholder={l('例如：周三晚班', 'For example: Wednesday evening cohort')}
              />
            </label>
            <label className="studio__field">
              <span>{l('日期', 'Date')}</span>
              <input
                type="date"
                value={klass.date}
                onChange={event => patchClass({ date: event.target.value })}
              />
            </label>
            <label className="studio__field instructor__field-wide">
              <span>{l('课程', 'Course')}</span>
              {courses.length > 0 ? (
                <select value={klass.courseSlug} onChange={event => selectCourse(event.target.value)}>
                  <option value="">{l('选择 bb_exam 课程', 'Select a bb_exam course')}</option>
                  {courses.map(course => (
                    <option key={course.slug} value={course.slug}>
                      {course.title}{course.moduleCount === undefined ? '' : ` · ${course.moduleCount} ${l('个模块', 'modules')}`}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={klass.courseTitle}
                  maxLength={160}
                  onChange={event => patchClass({ courseTitle: event.target.value })}
                  placeholder={l('课程名称', 'Course name')}
                />
              )}
            </label>
            <label className="studio__field instructor__field-wide">
              <span>{l('当前模块', 'Current module')}</span>
              {courseDetail !== undefined && courseDetail.modules.length > 0 ? (
                <select value={klass.moduleKey} onChange={event => selectModule(event.target.value)}>
                  <option value="">{l('首个模块', 'First module')}</option>
                  {courseDetail.modules.map(module => (
                    <option key={module.moduleKey} value={module.moduleKey}>{module.title}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={klass.moduleTitle}
                  maxLength={160}
                  onChange={event => patchClass({ moduleTitle: event.target.value })}
                  placeholder={l('模块名称', 'Module name')}
                />
              )}
            </label>
          </div>
          {catalogError ? <p className="studio__warn">{catalogError}</p> : null}
        </section>

        <aside className="instructor__panel instructor__session" aria-label={l('课堂计时', 'Session timer')}>
          <h3><Clock size={15} /> {l('课堂计时', 'Session')}</h3>
          <div className="instructor__timer">{formatDuration(elapsedSeconds)}</div>
          <div className="instructor__session-actions">
            <button
              type="button"
              className="studio__button studio__button--primary"
              onClick={running ? pauseSession : startSession}
            >
              {running ? <Pause size={14} /> : <Play size={14} />}
              {running ? l('暂停', 'Pause') : l('开始', 'Start')}
            </button>
            <button type="button" className="studio__button" onClick={resetSession}>
              <RotateCcw size={14} /> {l('重置', 'Reset')}
            </button>
          </div>
          <div className="instructor__counts">
            <span className="instructor__count instructor__count--present">{counts.present} {l('出席', 'present')}</span>
            <span className="instructor__count instructor__count--late">{counts.late} {l('迟到', 'late')}</span>
            <span className="instructor__count instructor__count--absent">{counts.absent} {l('缺席', 'absent')}</span>
          </div>
        </aside>
      </div>

      <section className="instructor__panel" aria-label={l('学生名单', 'Student roster')}>
        <header className="instructor__roster-header">
          <h3><Users size={15} /> {l('学生名单', 'Roster')} <small>{klass.students.length}/{instructorMaxStudentCount}</small></h3>
          <div className="instructor__roster-actions">
            <button type="button" className="studio__button" onClick={markAllPresent} disabled={klass.students.length === 0}>
              {l('全部出席', 'Mark all present')}
            </button>
            <button
              type="button"
              className="studio__button"
              onClick={addStudent}
              disabled={klass.students.length >= instructorMaxStudentCount}
            >
              <Plus size={14} /> {l('添加学生', 'Add student')}
            </button>
          </div>
        </header>
        <div className="instructor__roster" aria-label={l('学生名单', 'Student roster')}>
          <div className="instructor__roster-row instructor__roster-row--head" role="row">
            <span>#</span>
            <span>{l('姓名', 'Name')}</span>
            <span>{l('邮箱', 'Email')}</span>
            <span>{l('状态', 'Status')}</span>
            <span>{l('备注', 'Note')}</span>
            <span />
          </div>
          {klass.students.map((student, index) => (
            <div
              key={student.id}
              className={`instructor__roster-row instructor__roster-row--${student.status}`}
            >
              <span className="instructor__index">{index + 1}</span>
              <input
               
                aria-label={l(`学生 ${index + 1} 姓名`, `Student ${index + 1} name`)}
                value={student.name}
                maxLength={80}
                onChange={event => updateStudent(student.id, { name: event.target.value })}
              />
              <input
               
                aria-label={l(`学生 ${index + 1} 邮箱`, `Student ${index + 1} email`)}
                value={student.email}
                maxLength={160}
                onChange={event => updateStudent(student.id, { email: event.target.value })}
                placeholder="name@example.com"
              />
              <select
               
                aria-label={l(`学生 ${index + 1} 状态`, `Student ${index + 1} status`)}
                value={student.status}
                onChange={event => updateStudent(student.id, {
                  status: event.target.value as InstructorStudentStatus
                })}
              >
                <option value="present">{l('出席', 'Present')}</option>
                <option value="late">{l('迟到', 'Late')}</option>
                <option value="absent">{l('缺席', 'Absent')}</option>
              </select>
              <input
               
                aria-label={l(`学生 ${index + 1} 备注`, `Student ${index + 1} note`)}
                value={student.note}
                maxLength={160}
                onChange={event => updateStudent(student.id, { note: event.target.value })}
                placeholder={l('可选', 'Optional')}
              />
              <button
                type="button"
                className="instructor__remove"
                aria-label={l(`移除学生 ${index + 1}`, `Remove student ${index + 1}`)}
                onClick={() => removeStudent(student.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {klass.students.length === 0 ? (
            <p className="studio__muted">{l('还没有学生，点击“添加学生”开始。', 'No students yet. Use “Add student” to begin.')}</p>
          ) : null}
        </div>
      </section>

      <section className="instructor__panel">
        <h3>{l('课堂备注', 'Session notes')}</h3>
        <textarea
          className="instructor__notes"
          value={klass.notes}
          maxLength={4000}
          rows={4}
          onChange={event => patchClass({ notes: event.target.value })}
          placeholder={l('记录课堂节奏、提问或需要跟进的学生。', 'Capture pacing, questions, or students who need follow-up.')}
        />
      </section>
    </div>
  );
}

export function createInstructorClass(now = new Date()): InstructorClass {
  return {
    id: `instructor_class_${now.getTime().toString(36)}`,
    name: '',
    date: toDateInput(now),
    courseSlug: '',
    courseTitle: '',
    moduleKey: '',
    moduleTitle: '',
    students: Array.from({ length: instructorDefaultStudentCount }, (_, index) => createStudent(index + 1)),
    notes: '',
    elapsedSeconds: 0,
    runningSince: null,
    updatedAt: now.toISOString()
  };
}

export function loadInstructorClass(): InstructorClass {
  try {
    const raw = window.localStorage.getItem(instructorClassStorageKey);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<InstructorClass> | null;
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.students)) {
        return {
          ...createInstructorClass(),
          ...parsed,
          students: parsed.students.map((student, index) => ({
            ...createStudent(index + 1),
            ...student
          }))
        };
      }
    }
  } catch {
    // Fall through to a fresh class.
  }
  return createInstructorClass();
}

function createStudent(index: number): InstructorStudent {
  return {
    id: `instructor_student_${Date.now().toString(36)}_${index}`,
    name: '',
    email: '',
    status: 'present',
    note: ''
  };
}

function toDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
}
